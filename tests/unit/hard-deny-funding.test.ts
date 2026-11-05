/**
 * Review regressions for hard_deny funding across failover, the allow cache, leases, and
 * untracked surfaces with no output cap. The stub control plane follows core's accounting rules
 * (see `plane`): a check reserves the output bound x output rate, hard_deny denies a reservation
 * that does not fit the cap, and only receipted or ingested spend survives a hold's expiry, a
 * lease's surrender and a reconcile. Rates are synthetic.
 */

import { wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { createSolwynMiddleware } from "../../src/ai-sdk/index";
import {
  BudgetExceededError,
  OutputBoundUnenforceableError,
  UntrackedSpendSurfaceError,
} from "../../src/errors";
import { Solwyn } from "../../src/index";
import { run } from "../../src/node";
import type { FetchLike } from "../../src/transport";

const API_KEY = `solwyn_sk_${"a".repeat(64)}`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;

type Body = Record<string, unknown>;

const RATES: Record<string, { input: number; output: number }> = {
  "primary-model": { input: 0, output: 1 / 100_000_000 },
  "primary-b": { input: 0, output: 1 / 100_000_000 },
  "fallback-model": { input: 0, output: 1 / 1_000_000 },
  "third-model": { input: 0, output: 1 / 1_000_000 },
  "gpt-6-luna": { input: 0, output: 1 / 1_000_000 },
  "gpt-6-luna-reasoning": { input: 0, output: 1 / 1_000_000 },
  "grok-4-fast-non-reasoning": { input: 0, output: 1 / 1_000_000 },
};

interface LeaseSpec {
  readonly grant: Body;
}

/** A hard_deny plane with real holds; optionally grants one lease. */
function plane(cap: number, lease?: LeaseSpec, mode: "hard_deny" | "alert_only" = "hard_deny") {
  const checks: Body[] = [];
  const confirms: Body[] = [];
  const events: Body[] = [];
  const grants: Body[] = [];
  const surrenders: Body[] = [];
  // Core's rules (solwyn-ai/core d948823d): a per-call hold lives until it expires; an on-time
  // ordinary per-call confirm moves only the Redis counter, which reconcile lowers to durable
  // spend; an is_estimated, late or lease confirm writes a durable receipt; durable spend counts
  // max(receipt, ingested events) per call id, whatever the event's status.
  const holds = new Map<string, number>();
  const issued = new Set<string>();
  const receipts = new Map<string, number>();
  const eventCost = new Map<string, number>();
  let redis = 0;
  let reservations = 0;
  const cost = (model: string, output: number) => output * (RATES[model]?.output ?? 0);
  const held = () => [...holds.values()].reduce((sum, value) => sum + value, 0);
  const durable = () =>
    [...new Set([...receipts.keys(), ...eventCost.keys()])].reduce(
      (sum, callId) => sum + Math.max(receipts.get(callId) ?? 0, eventCost.get(callId) ?? 0),
      0,
    );
  const spent = () => Math.max(redis, durable());
  const fetch: FetchLike = async (url, init) => {
    const pathname = new URL(url).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (pathname === "/api/v1/budgets/lease" && lease !== undefined) {
      grants.push(body as Body);
      return Response.json(lease.grant);
    }
    if (pathname === "/api/v1/budgets/lease/surrender") {
      // Advisory: the reported spent_tokens settles nothing; only receipts and events survive.
      surrenders.push(body as Body);
      return Response.json({ lease_id: "", spent_tokens: 0, accepted: true });
    }
    if (pathname.startsWith("/api/v1/budgets/lease")) return new Response(null, { status: 204 });
    if (pathname === "/api/v1/budgets/check") {
      const check = body as Body;
      checks.push(check);
      const reserve = cost(check["model"] as string, check["estimated_output_bound"] as number);
      const allowed = mode === "alert_only" || spent() + held() + reserve <= cap + 1e-12;
      const reservationId = allowed ? `res-${++reservations}` : null;
      if (reservationId !== null) {
        holds.set(reservationId, reserve);
        issued.add(reservationId);
      }
      return Response.json({
        allowed,
        remaining_budget: cap - spent() - held(),
        reservation_id: reservationId,
        mode,
        budget_limit: cap,
        current_usage: spent(),
        denied_by_period: allowed ? null : "monthly",
        project_id: PROJECT_ID,
        price_hints: null,
      });
    }
    if (pathname === "/api/v1/budgets/confirm") {
      const confirm = body as Body;
      confirms.push(confirm);
      const details = confirm["token_details"] as Body;
      const settled = cost(confirm["model"] as string, details["output_tokens"] as number);
      const callId = confirm["call_id"] as string;
      const reservationId = confirm["reservation_id"] as string | undefined;
      if (reservationId === undefined || !holds.has(reservationId)) {
        // A lease confirm, or a late per-call confirm within the hour: a durable receipt.
        if (reservationId !== undefined && !issued.has(reservationId))
          return new Response(null, { status: 404 });
        if (!receipts.has(callId)) receipts.set(callId, settled);
        return new Response(null, { status: 204 });
      }
      holds.delete(reservationId);
      redis += settled;
      if (details["is_estimated"] === true && !receipts.has(callId)) receipts.set(callId, settled);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/v1/metadata/ingest" && Array.isArray(body)) {
      events.push(...body);
      for (const event of body as Body[]) {
        if (event["status"] === "budget_denied") continue;
        const callId = event["call_id"] as string;
        const priced = cost(event["model"] as string, (event["output_tokens"] as number) ?? 0);
        eventCost.set(callId, (eventCost.get(callId) ?? 0) + priced);
      }
    }
    return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
  };
  return {
    fetch,
    checks,
    confirms,
    events,
    grants,
    surrenders,
    held,
    spent,
    /** Every unconfirmed per-call hold reaches its 300 s expiry. */
    expire: () => holds.clear(),
    /** Reconcile past the settle window: the counter falls to durable spend. */
    reconcile: () => {
      redis = 0;
    },
  };
}

function usage(output: number) {
  return { usage: { prompt_tokens: 0, completion_tokens: output } };
}

function failing(status: number) {
  return vi.fn((_kwargs: Body) => {
    throw Object.assign(new Error(`synthetic ${status}`), { status });
  });
}

function chat(solwyn: unknown, body: Body): Promise<unknown> {
  return (
    solwyn as { chat: { completions: { create(b: Body): Promise<unknown> } } }
  ).chat.completions.create(body);
}

function client(create: (kwargs: Body) => unknown) {
  return { chat: { completions: { create } } };
}

const MESSAGES = [{ role: "user", content: "synthetic" }];

describe("finding 1: a hop re-check does not reuse the call's lease claim id", () => {
  it("checks and serves the fallback when the run's lease grant is ineligible", async () => {
    const stub = plane(1, {
      grant: {
        eligible: false,
        allowed: false,
        lease_id: null,
        generation: null,
        granted_tokens: null,
        refresh_interval_s: null,
        lease_length_s: null,
        headroom_share_tokens: null,
        posture: null,
        final_grant: false,
        project_id: PROJECT_ID,
        mode: "hard_deny",
        budget_limit: 1,
        current_usage: 0,
        remaining_budget: 1,
        ineligible_reason: "unit_priced_model",
      },
    });
    const primary = failing(429);
    const fallback = vi.fn((_kwargs: Body) => usage(2));
    const solwyn = new Solwyn(client(primary), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
      fallback: [[client(fallback), "fallback-model", {}, "openai"]],
    });

    await run("ineligible-lease", () =>
      chat(solwyn, { model: "primary-model", messages: MESSAGES }),
    );
    await solwyn.close();

    expect(stub.grants).toHaveLength(1);
    expect(stub.checks.map((check) => check["model"])).toEqual(["primary-model", "fallback-model"]);
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe("finding 2: a possibly billed hold stays held across later attempts", () => {
  it("funds each attempt after an ambiguous failure separately and never zero-settles its hold", async () => {
    const stub = plane(1);
    const primary = failing(503);
    const sameIdentity = failing(429);
    const third = vi.fn((_kwargs: Body) => usage(1000));
    const solwyn = new Solwyn(client(primary), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
      failoverIdempotency: "always",
      fallback: [
        [client(sameIdentity), "primary-model", {}, "openai"],
        [client(third), "third-model", {}, "openai"],
      ],
    });

    await chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 3000 });
    await solwyn.close();

    expect(sameIdentity).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    // The same-identity attempt after the ambiguous failure got its own check.
    expect(stub.checks.map((check) => check["model"])).toEqual([
      "primary-model",
      "primary-model",
      "third-model",
    ]);
    // The ambiguous hold (res-1) is settled at its floor, never at zero, under its own call id;
    // only the clean 429 hold is settled at zero.
    expect(stub.confirms).toMatchObject([
      {
        reservation_id: "res-1",
        model: "primary-model",
        token_details: { input_tokens: 2, output_tokens: 3000, is_estimated: true },
      },
      { reservation_id: "res-2", token_details: { output_tokens: 0 } },
      { reservation_id: "res-3", model: "third-model", token_details: { output_tokens: 1000 } },
    ]);
    const floorCallId = stub.confirms[0]?.["call_id"];
    expect(floorCallId).not.toBe(stub.confirms[2]?.["call_id"]);
    const ambiguousEvent = stub.events.find(
      (event) => event["status"] === "error" && event["attempt_index"] === 0,
    );
    expect(ambiguousEvent?.["call_id"]).toBe(floorCallId);
  });
});

describe("finding 4: hop checks are fresh and reservation-backed with the default cache", () => {
  it("re-checks a fallback shared by two freshly checked primaries and refuses the one that no longer fits", async () => {
    // $0.01 cap. The first call's fallback spends $0.008, so a second $0.008 fallback cannot fit.
    const stub = plane(0.01);
    const fallback = vi.fn((_kwargs: Body) => usage(8000));
    const solwyn = new Solwyn(client(failing(429)), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
      fallback: [[client(fallback), "fallback-model", { max_tokens: 8000 }, "openai"]],
      // Settle promptly so the test observes spend; the allow cache keeps its default config.
      reporterFlushInterval: 0.01,
    });

    await chat(solwyn, { model: "primary-model", messages: MESSAGES });
    await vi.waitFor(() => expect(stub.spent()).toBeCloseTo(0.008, 9), { timeout: 10_000 });
    const second = await chat(solwyn, { model: "primary-b", messages: MESSAGES }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    await solwyn.close();

    expect(second).toBeInstanceOf(BudgetExceededError);
    expect(stub.checks.filter((check) => check["model"] === "fallback-model")).toHaveLength(2);
    expect(fallback).toHaveBeenCalledOnce();
    expect(stub.spent()).toBeLessThanOrEqual(0.01);
  });
});

describe("finding 5: a lease-funded ambiguous attempt does not fund the next attempt", () => {
  it("consumes the claim at its floor and checks the next attempt per call", async () => {
    const stub = plane(1, {
      grant: {
        eligible: true,
        allowed: true,
        lease_id: "lease-final",
        generation: 1,
        granted_tokens: 200,
        refresh_interval_s: 300,
        lease_length_s: 600,
        headroom_share_tokens: 0,
        posture: { mode: "hard_deny", on_unreachable: "fail_open" },
        final_grant: true,
        project_id: PROJECT_ID,
        mode: "hard_deny",
        budget_limit: 1,
        current_usage: 0,
        remaining_budget: 1,
      },
    });
    const primary = failing(503);
    const fallback = vi.fn((_kwargs: Body) => usage(128));
    const solwyn = new Solwyn(client(primary), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
      failoverIdempotency: "always",
      fallback: [[client(fallback), "fallback-model", { max_tokens: 128 }, "openai"]],
    });

    await run("ambiguous-lease", () =>
      chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 }),
    );
    await solwyn.close();

    expect(stub.grants).toHaveLength(1);
    expect(fallback).toHaveBeenCalledOnce();
    // The fallback is funded by its own per-call check, not by the possibly billed claim, and the
    // claim is recorded at its floor under the failed hop's own call id.
    expect(stub.checks.map((check) => check["model"])).toEqual(["fallback-model"]);
    expect(stub.confirms).toMatchObject([
      {
        lease_id: "lease-final",
        model: "primary-model",
        token_details: { output_tokens: 128, is_estimated: true },
      },
      { reservation_id: "res-1", model: "fallback-model", token_details: { output_tokens: 128 } },
    ]);
    expect(stub.confirms[0]?.["call_id"]).not.toBe(stub.confirms[1]?.["call_id"]);
    // The lease reports the ambiguous attempt's whole reservation (input plus 128) as spent.
    expect(stub.surrenders[0]?.["spent_tokens"]).toBeGreaterThanOrEqual(128);
  });
});

describe("finding 6: lease coverage matches (provider, model) pairs", () => {
  it("does not lease-fund a declared model id served by another provider", async () => {
    const stub = plane(1, {
      grant: {
        eligible: true,
        allowed: true,
        lease_id: "lease-pairs",
        generation: 1,
        granted_tokens: 50_000,
        refresh_interval_s: 300,
        lease_length_s: 600,
        headroom_share_tokens: 5_000,
        posture: { mode: "hard_deny", on_unreachable: "fail_open" },
        final_grant: false,
        project_id: PROJECT_ID,
        mode: "hard_deny",
        budget_limit: 1,
        current_usage: 0,
        remaining_budget: 1,
      },
    });
    const groq = vi.fn((_kwargs: Body) => usage(1));
    const together = vi.fn((_kwargs: Body) => usage(1));
    const solwyn = new Solwyn(
      { chat: { completions: { create: groq } }, baseURL: "https://api.groq.com/openai/v1" },
      {
        apiKey: API_KEY,
        fetch: stub.fetch,
        fallback: [
          [
            { chat: { completions: { create: together } }, baseURL: "https://api.together.xyz/v1" },
            "openai/gpt-oss-20b",
          ],
        ],
      },
    );

    await run("provider-pairs", async () => {
      await chat(solwyn, { model: "llama-3.1-8b-instant", messages: MESSAGES });
      await chat(solwyn, { model: "openai/gpt-oss-20b", messages: MESSAGES });
    });
    await solwyn.close();

    expect(stub.grants[0]).toMatchObject({
      provider: "groq",
      model: "llama-3.1-8b-instant",
      fallback_providers: ["together"],
      fallback_models: ["openai/gpt-oss-20b"],
    });
    // Groq serving openai/gpt-oss-20b is not the declared Together entry: it gets a per-call check.
    expect(stub.checks).toMatchObject([{ provider: "groq", model: "openai/gpt-oss-20b" }]);
  });
});

describe("finding 3: decisions.create has no output cap", () => {
  function decisionsClient() {
    const sent: unknown[] = [];
    const native = new OpenAI({
      apiKey: "sk-test",
      fetch: async (url: unknown, init?: { body?: unknown }) => {
        sent.push(url);
        if (String(url).includes("/decisions")) return Response.json({ id: "dec_1" });
        const body = JSON.parse(String(init?.body)) as Body;
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: body["model"],
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        });
      },
    });
    return { native, sent };
  }

  it("refuses under hard_deny with the default posture, leaves no hold, and admits the next call", async () => {
    const stub = plane(0.0042);
    const { native, sent } = decisionsClient();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch, logger: undefined });
    const decisions = (solwyn as unknown as { decisions: { create(b: Body): Promise<unknown> } })
      .decisions;

    const error = await decisions.create({ model: "gpt-6-luna", input: "synthetic" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OutputBoundUnenforceableError);
    expect(error).toMatchObject({ code: "output_bound_unenforceable", reason: "no_output_cap" });
    expect(sent).toHaveLength(0);
    // The gate's check reservation is settled at zero, so no hold is left.
    await vi.waitFor(() => expect(stub.confirms).toHaveLength(1));
    expect(stub.confirms[0]).toMatchObject({ token_details: { output_tokens: 0 } });
    expect(stub.held()).toBe(0);

    // A following call that fits the whole cap is admitted.
    await chat(solwyn, { model: "gpt-6-luna", messages: MESSAGES });
    await solwyn.close();
    expect(sent).toHaveLength(1);
  });

  it("is refused by onUnmetered raise first, with no budget check", async () => {
    const stub = plane(1);
    const { native, sent } = decisionsClient();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch, onUnmetered: "raise" });
    const read = () =>
      (solwyn as unknown as { decisions: { create(b: Body): Promise<unknown> } }).decisions.create({
        model: "gpt-6-luna",
        input: "synthetic",
      });
    expect(read).toThrow(UntrackedSpendSurfaceError);
    await solwyn.close();
    expect(stub.checks).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("goes through untracked on an alert-only project after one zero-settled check", async () => {
    const stub = plane(1);
    const alertOnly: FetchLike = async (url, init) => {
      const response = await stub.fetch(url, init);
      if (!url.includes("/budgets/check")) return response;
      return Response.json({ ...((await response.json()) as Body), mode: "alert_only" });
    };
    const { native, sent } = decisionsClient();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: alertOnly });
    await (
      solwyn as unknown as { decisions: { create(b: Body): Promise<unknown> } }
    ).decisions.create({ model: "gpt-6-luna", input: "synthetic" });
    await vi.waitFor(() => expect(stub.held()).toBe(0));
    await solwyn.close();
    expect(stub.checks).toHaveLength(1);
    expect(stub.confirms).toMatchObject([{ token_details: { output_tokens: 0 } }]);
    expect(sent).toHaveLength(1);
  });

  it("is still denied as a budget denial when nothing fits", async () => {
    const stub = plane(0);
    const { native, sent } = decisionsClient();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch });
    const decisions = (solwyn as unknown as { decisions: { create(b: Body): Promise<unknown> } })
      .decisions;
    await expect(
      decisions.create({ model: "gpt-6-luna", input: "synthetic" }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();
    expect(sent).toHaveLength(0);
  });
});

describe("a pre-send refusal leaves no hold", () => {
  it("settles the check's reservation at zero, so the next call fits", async () => {
    // The refused reasoning call reserves almost the whole cap before it is refused locally.
    const stub = plane(0.0042);
    const sent: Body[] = [];
    const native = new OpenAI({
      apiKey: "sk-test",
      baseURL: "https://api.x.ai/v1",
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body)) as Body;
        sent.push(body);
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: body["model"],
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        });
      },
    });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch });

    const error = await chat(solwyn, { model: "gpt-6-luna-reasoning", messages: MESSAGES }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ reason: "reasoning_without_budget" });
    expect(sent).toHaveLength(0);
    await vi.waitFor(() => expect(stub.held()).toBe(0));
    expect(stub.confirms).toMatchObject([{ token_details: { output_tokens: 0 } }]);

    await chat(solwyn, { model: "grok-4-fast-non-reasoning", messages: MESSAGES });
    await solwyn.close();
    expect(sent).toHaveLength(1);
  });
});

describe("a terminal possibly billed attempt keeps its lease claim", () => {
  function finalLease() {
    return plane(1, {
      grant: {
        eligible: true,
        allowed: true,
        lease_id: "lease-terminal",
        generation: 1,
        granted_tokens: 200,
        refresh_interval_s: 300,
        lease_length_s: 600,
        headroom_share_tokens: 0,
        posture: { mode: "hard_deny", on_unreachable: "fail_open" },
        final_grant: true,
        project_id: PROJECT_ID,
        mode: "hard_deny",
        budget_limit: 1,
        current_usage: 0,
        remaining_budget: 1,
      },
    });
  }

  it.each([
    ["the primary", false],
    ["the last fallback", true],
  ])("consumes the claim when %s fails ambiguously and the walk ends", async (_label, withFallback) => {
    const stub = finalLease();
    let calls = 0;
    const primary = vi.fn((_kwargs: Body) => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new Error("synthetic"), { status: withFallback ? 429 : 503 });
      return usage(128);
    });
    const fallback = failing(503);
    const solwyn = new Solwyn(client(primary), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
      failoverIdempotency: "always",
      ...(withFallback
        ? { fallback: [[client(fallback), "fallback-model", { max_tokens: 128 }, "openai"]] }
        : {}),
    });

    await run("terminal-ambiguous", async () => {
      await expect(
        chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 }),
      ).rejects.toMatchObject({ status: 503 });
      // The possibly billed claim was not refunded, so the final lease cannot fund this call.
      await chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 });
    });
    await solwyn.close();

    expect(stub.grants).toHaveLength(1);
    expect(stub.checks.map((check) => check["model"])).toEqual(["primary-model"]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBeGreaterThanOrEqual(128);
  });
});

/** A final hard_deny lease of 200 tokens: one 128-token call fits, a second does not. */
function finalLeasePlane(grantedTokens = 200) {
  return plane(1, {
    grant: {
      eligible: true,
      allowed: true,
      lease_id: "lease-r3",
      generation: 1,
      granted_tokens: grantedTokens,
      refresh_interval_s: 300,
      lease_length_s: 600,
      headroom_share_tokens: 0,
      posture: { mode: "hard_deny", on_unreachable: "fail_open" },
      final_grant: true,
      project_id: PROJECT_ID,
      mode: "hard_deny",
      budget_limit: 1,
      current_usage: 0,
      remaining_budget: 1,
    },
  });
}

const encoder = new TextEncoder();

function sseChunk(model: string, content: string): Uint8Array {
  const chunk = {
    id: "chatcmpl-r3",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

function completion(model: string, output: number) {
  return Response.json({
    id: "chatcmpl-r3",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 0, completion_tokens: output, total_tokens: output },
  });
}

/**
 * A native OpenAI client whose first streamed call sends one chunk and then either fails with a
 * socket reset or keeps sending chunks until the reader stops. Buffered calls bill 128 tokens.
 */
function streamingNative(ending: "reset" | "endless") {
  return new OpenAI({
    apiKey: "sk-test",
    maxRetries: 0,
    fetch: async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal | null }) => {
      const body = JSON.parse(String(init?.body)) as Body;
      const model = body["model"] as string;
      if (body["stream"] !== true) return completion(model, 128);
      let sent = false;
      return new Response(
        new ReadableStream({
          start(controller) {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
          pull(controller) {
            if (!sent || ending === "endless") {
              sent = true;
              controller.enqueue(sseChunk(model, "synthetic"));
              return;
            }
            controller.error(
              Object.assign(new TypeError("synthetic socket closed"), {
                cause: { code: "ECONNRESET" },
              }),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}

describe("r3 finding 1: an established stream that ends without known usage keeps its claim", () => {
  it.each([
    ["fails mid-stream", "reset"],
    ["is closed by the caller", "endless"],
  ] as const)("consumes the claim when the stream %s", async (_label, ending) => {
    const stub = finalLeasePlane();
    const solwyn = new Solwyn(streamingNative(ending), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
    });

    await run("r3-stream", async () => {
      const stream = (await chat(solwyn, {
        model: "primary-model",
        messages: MESSAGES,
        max_tokens: 128,
        stream: true,
      })) as AsyncIterable<unknown>;
      const consume = async () => {
        for await (const _part of stream) {
          if (ending === "endless") break;
        }
      };
      if (ending === "reset") await expect(consume()).rejects.toThrow();
      else await consume();
      // The stream may have billed its whole bound, so the final lease cannot fund this call.
      await chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 });
    });
    await solwyn.close();

    expect(stub.grants).toHaveLength(1);
    expect(stub.checks.map((check) => check["model"])).toEqual(["primary-model"]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBeGreaterThanOrEqual(128);
  });

  it("settles a per-call hold at its floor when the stream fails mid-stream", async () => {
    const stub = plane(1);
    const solwyn = new Solwyn(streamingNative("reset"), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
    });
    const stream = (await chat(solwyn, {
      model: "fallback-model",
      messages: MESSAGES,
      max_tokens: 128,
      stream: true,
    })) as AsyncIterable<unknown>;
    await expect(
      (async () => {
        for await (const _part of stream) {
          // drain
        }
      })(),
    ).rejects.toThrow();
    await solwyn.close();

    // The possibly billed hold is settled at its reservation, durably and marked estimated.
    expect(stub.confirms).toMatchObject([
      {
        reservation_id: "res-1",
        model: "fallback-model",
        token_details: { input_tokens: 2, output_tokens: 128, is_estimated: true },
      },
    ]);
    stub.expire();
    stub.reconcile();
    expect(stub.spent()).toBeCloseTo(128 / 1_000_000, 12);
  });
});

describe("r3 finding 3: a known rejection wins over a caller abort", () => {
  it.each([
    [400, false],
    [400, true],
    [429, false],
    [429, true],
  ])("releases the claim when OpenAI answers %i after the abort (stream %s)", async (status, streaming) => {
    const stub = finalLeasePlane();
    const controller = new AbortController();
    let fetches = 0;
    const native = new OpenAI({
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async () => {
        fetches += 1;
        controller.abort();
        return Response.json(
          { error: { message: "synthetic rejection", type: "synthetic", code: "synthetic" } },
          { status },
        );
      },
    });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch, provider: "openai" });

    await run("r3-abort", async () => {
      await expect(
        (
          solwyn as unknown as {
            chat: { completions: { create(b: Body, o: unknown): Promise<unknown> } };
          }
        ).chat.completions.create(
          { model: "gpt-6-luna", messages: MESSAGES, max_tokens: 128, stream: streaming },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ status });
    });
    await solwyn.close();

    expect(fetches).toBe(1);
    expect(stub.checks).toEqual([]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBe(0);
  });
});

describe("r3 finding 2: the AI SDK middleware keeps possibly billed hard_deny funding", () => {
  const finished = {
    content: [{ type: "text" as const, text: "synthetic" }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 128, text: 128, reasoning: 0 },
    },
    warnings: [],
  };
  const ambiguous = () => Object.assign(new Error("synthetic ambiguity"), { status: 503 });

  it.each([
    "generate",
    "establishment",
    "midstream",
  ] as const)("consumes the claim after a %s failure", async (stage) => {
    const stub = finalLeasePlane();
    let calls = 0;
    const native = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "primary-model",
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) throw ambiguous();
        return finished;
      },
      doStream: async () => {
        calls += 1;
        if (stage === "establishment") throw ambiguous();
        let index = 0;
        return {
          stream: new ReadableStream({
            pull(controller) {
              if (index++ === 0)
                controller.enqueue({ type: "text-delta", id: "synthetic", delta: "synthetic" });
              else controller.error(ambiguous());
            },
          }),
        };
      },
    });
    const handle = createSolwynMiddleware({ apiKey: API_KEY, fetch: stub.fetch });
    const model = wrapLanguageModel({ model: native, middleware: handle.middleware });

    await run("r3-middleware", async () => {
      const first = async () => {
        if (stage === "generate") {
          await model.doGenerate({ prompt: [], maxOutputTokens: 128 });
          return;
        }
        const result = await model.doStream({ prompt: [], maxOutputTokens: 128 });
        for await (const _part of result.stream as unknown as AsyncIterable<unknown>) {
          // drain
        }
      };
      await expect(first()).rejects.toThrow();
      // The possibly billed claim was not refunded, so the final lease cannot fund this call.
      await model.doGenerate({ prompt: [], maxOutputTokens: 128 });
    });
    await handle.close();

    expect(calls).toBe(2);
    expect(stub.grants).toHaveLength(1);
    expect(stub.checks.map((check) => check["model"])).toEqual(["primary-model"]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBeGreaterThanOrEqual(128);
  });

  it("releases the claim when the provider rejects the call with a 400", async () => {
    const stub = finalLeasePlane();
    const native = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "primary-model",
      doGenerate: async () => {
        throw Object.assign(new Error("synthetic rejection"), { status: 400 });
      },
    });
    const handle = createSolwynMiddleware({ apiKey: API_KEY, fetch: stub.fetch });
    const model = wrapLanguageModel({ model: native, middleware: handle.middleware });

    await run("r3-middleware-rejected", async () => {
      await expect(model.doGenerate({ prompt: [], maxOutputTokens: 128 })).rejects.toThrow();
    });
    await handle.close();

    expect(stub.checks).toEqual([]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBe(0);
  });
});

describe("r4 finding 3: a deferred Responses entry rejection releases its claim", () => {
  it.each([
    400, 429,
  ])("releases the claim when responses.stream() is answered %i before connect", async (status) => {
    const stub = finalLeasePlane();
    let fetches = 0;
    const native = new OpenAI({
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        fetches += 1;
        const body = JSON.parse(String(init?.body)) as Body;
        if (fetches === 1)
          return Response.json(
            { error: { message: "synthetic rejection", type: "synthetic" } },
            { status },
          );
        return completion(body["model"] as string, 128);
      },
    });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch, provider: "openai" });

    await run("r4-responses-rejection", async () => {
      const responses = (
        solwyn as unknown as {
          responses: { stream(b: Body): { done(): Promise<unknown> } };
        }
      ).responses;
      await expect(
        responses.stream({ model: "primary-model", input: [], max_output_tokens: 128 }).done(),
      ).rejects.toMatchObject({ status });
      // Nothing was billed, so the final lease still funds this call.
      await chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 });
    });
    await solwyn.close();

    expect(fetches).toBe(2);
    expect(stub.checks).toEqual([]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBe(128);
  });
});

describe("r4 finding 4: an unrecognized failure after dispatch keeps its funding", () => {
  it("consumes the claim when a native OpenAI 200 response fails to parse", async () => {
    const stub = finalLeasePlane();
    let fetches = 0;
    const native = new OpenAI({
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        fetches += 1;
        const body = JSON.parse(String(init?.body)) as Body;
        if (fetches === 1)
          return new Response('{"id":"chatcmpl-r4","usage":', {
            headers: { "content-type": "application/json" },
          });
        return completion(body["model"] as string, 128);
      },
    });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch, provider: "openai" });

    await run("r4-parse", async () => {
      await expect(
        chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 }),
      ).rejects.toBeInstanceOf(SyntaxError);
      // The truncated 200 may have billed its bound, so the final lease cannot fund this call.
      await chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 });
    });
    await solwyn.close();

    expect(fetches).toBe(2);
    expect(stub.checks.map((check) => check["model"])).toEqual(["primary-model"]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBeGreaterThanOrEqual(128);
  });

  it("consumes the claim when a wrapped AI SDK model throws an unrecognized error", async () => {
    const stub = finalLeasePlane();
    let calls = 0;
    const native = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "primary-model",
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) throw new SyntaxError("synthetic paid response parse failure");
        return {
          content: [{ type: "text" as const, text: "synthetic" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 128, text: 128, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const handle = createSolwynMiddleware({ apiKey: API_KEY, fetch: stub.fetch });
    const model = wrapLanguageModel({ model: native, middleware: handle.middleware });

    await run("r4-middleware-parse", async () => {
      await expect(model.doGenerate({ prompt: [], maxOutputTokens: 128 })).rejects.toBeInstanceOf(
        SyntaxError,
      );
      await model.doGenerate({ prompt: [], maxOutputTokens: 128 });
    });
    await handle.close();

    expect(calls).toBe(2);
    expect(stub.checks.map((check) => check["model"])).toEqual(["primary-model"]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBeGreaterThanOrEqual(128);
  });

  it("releases the claim when preparing the call fails before dispatch", async () => {
    const stub = finalLeasePlane();
    const create = vi.fn((_kwargs: Body) => usage(128));
    const solwyn = new Solwyn(client(create), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
    });
    const { OpenAIAdapter } = await import("../../src/providers/openai");
    const prepare = vi.spyOn(OpenAIAdapter.prototype, "prepareCall").mockImplementationOnce(() => {
      throw new Error("synthetic local preparation failure");
    });

    try {
      await run("r4-undispatched", async () => {
        await expect(
          chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 }),
        ).rejects.toThrow("synthetic local preparation failure");
        await chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 });
      });
    } finally {
      prepare.mockRestore();
      await solwyn.close();
    }

    expect(create).toHaveBeenCalledOnce();
    expect(stub.checks).toEqual([]);
    expect(stub.surrenders[0]?.["spent_tokens"]).toBe(128);
  });
});

describe("Anthropic 529 overloaded_error is a known rejection", () => {
  it.each([
    [529, "releases"],
    [500, "keeps"],
  ] as const)("a hard_deny %i failover %s the failed attempt's funding", async (status, outcome) => {
    const stub = finalLeasePlane();
    const primary = failing(status);
    const fallback = vi.fn((_kwargs: Body) => usage(128));
    const solwyn = new Solwyn(client(primary), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
      failoverIdempotency: "always",
      fallback: [[client(fallback), "fallback-model", { max_tokens: 128 }, "openai"]],
    });

    await run("overloaded-failover", () =>
      chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 }),
    );
    await solwyn.close();

    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(stub.grants).toHaveLength(1);
    if (outcome === "releases") {
      // The 529 billed nothing, so the call's claim still funds the fallback.
      expect(stub.checks).toEqual([]);
      expect(stub.confirms).toMatchObject([
        { lease_id: "lease-r3", model: "fallback-model", token_details: { output_tokens: 128 } },
      ]);
    } else {
      // A 500 may have billed: its claim is kept and the fallback gets its own check.
      expect(stub.checks.map((check) => check["model"])).toEqual(["fallback-model"]);
    }
  });
});

describe("a response body that fails to decode is post-send ambiguous", () => {
  function truncatedPrimary() {
    let fetches = 0;
    const native = new OpenAI({
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async () => {
        fetches += 1;
        return new Response('{"id":"chatcmpl-decode","usage":', {
          headers: { "content-type": "application/json" },
        });
      },
    });
    return { native, fetches: () => fetches };
  }

  it.each([
    ["hard_deny", "always", true],
    ["hard_deny", "safe", false],
    ["alert_only", "always", true],
    ["alert_only", "safe", false],
  ] as const)("on %s under %s, fails over: %s", async (mode, failoverIdempotency, failsOver) => {
    const stub = plane(1, undefined, mode);
    const primary = truncatedPrimary();
    const fallback = vi.fn((_kwargs: Body) => usage(2));
    const solwyn = new Solwyn(primary.native, {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
      failoverIdempotency,
      fallback: [[client(fallback), "fallback-model", { max_tokens: 128 }, "openai"]],
    });

    const call = chat(solwyn, { model: "primary-model", messages: MESSAGES, max_tokens: 128 });
    if (failsOver) await call;
    else await expect(call).rejects.toBeInstanceOf(SyntaxError);
    await solwyn.close();

    expect(primary.fetches()).toBe(1);
    expect(fallback).toHaveBeenCalledTimes(failsOver ? 1 : 0);
    // An ambiguous failure that ends the call is reported as possibly succeeded.
    if (!failsOver)
      expect(stub.events.find((event) => event["status"] === "error")).toMatchObject({
        model: "primary-model",
        possibly_succeeded: true,
      });
    if (failsOver && mode === "hard_deny") {
      // The next hop is re-admitted with its own check; the possibly billed hold is settled at
      // its floor first.
      expect(stub.checks.map((check) => check["model"])).toEqual([
        "primary-model",
        "fallback-model",
      ]);
      expect(stub.confirms).toMatchObject([
        { model: "primary-model", token_details: { output_tokens: 128, is_estimated: true } },
        { model: "fallback-model", token_details: { output_tokens: 2 } },
      ]);
    }
  });
});

describe("a hard_deny floor survives a hold's expiry, a lease's surrender and a reconcile", () => {
  // One 128-token fallback-model floor plus another 128-token call does not fit; either alone does.
  const CAP = 200 / 1_000_000;
  const BODY = { model: "fallback-model", messages: MESSAGES, max_tokens: 128 };

  function tightPlane(leased: boolean) {
    if (!leased) return plane(CAP);
    return plane(CAP, {
      grant: {
        eligible: true,
        allowed: true,
        lease_id: "lease-floor",
        generation: 1,
        granted_tokens: 200,
        refresh_interval_s: 300,
        lease_length_s: 600,
        headroom_share_tokens: 0,
        posture: { mode: "hard_deny", on_unreachable: "fail_open" },
        final_grant: true,
        project_id: PROJECT_ID,
        mode: "hard_deny",
        budget_limit: CAP,
        current_usage: 0,
        remaining_budget: CAP,
      },
    });
  }

  async function nextCallIsDenied(stub: ReturnType<typeof plane>): Promise<void> {
    stub.expire();
    stub.reconcile();
    const next = new Solwyn(client(vi.fn((_kwargs: Body) => usage(1))), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
    });
    try {
      await expect(chat(next, BODY)).rejects.toBeInstanceOf(BudgetExceededError);
    } finally {
      await next.close();
    }
  }

  async function drain(stream: unknown, stopEarly = false): Promise<void> {
    for await (const _part of stream as AsyncIterable<unknown>) {
      if (stopEarly) break;
    }
  }

  const STREAM_PATHS = new Set([
    "a mid-stream error",
    "an early close",
    "a caller abort mid-stream",
    "a client close with the stream unread",
  ]);
  const paths: ReadonlyArray<readonly [string, (fetch: FetchLike) => Promise<void>]> = [
    [
      "a mid-stream error",
      async (fetch) => {
        const solwyn = new Solwyn(streamingNative("reset"), { apiKey: API_KEY, fetch });
        const stream = await chat(solwyn, { ...BODY, stream: true });
        await expect(drain(stream)).rejects.toThrow();
        await solwyn.close();
      },
    ],
    [
      "an early close",
      async (fetch) => {
        const solwyn = new Solwyn(streamingNative("endless"), { apiKey: API_KEY, fetch });
        await drain(await chat(solwyn, { ...BODY, stream: true }), true);
        await solwyn.close();
      },
    ],
    [
      "a caller abort mid-stream",
      async (fetch) => {
        const controller = new AbortController();
        const solwyn = new Solwyn(streamingNative("endless"), { apiKey: API_KEY, fetch });
        const stream = await (
          solwyn as unknown as {
            chat: { completions: { create(b: Body, o: unknown): Promise<unknown> } };
          }
        ).chat.completions.create({ ...BODY, stream: true }, { signal: controller.signal });
        const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await iterator.next();
        controller.abort();
        // Native OpenAI ends an aborted stream quietly, as if it had run to its end.
        await expect(iterator.next()).resolves.toMatchObject({ done: true });
        await solwyn.close();
      },
    ],
    [
      "a client close with the stream unread",
      async (fetch) => {
        const solwyn = new Solwyn(streamingNative("endless"), { apiKey: API_KEY, fetch });
        await chat(solwyn, { ...BODY, stream: true });
        await solwyn.close();
      },
    ],
    [
      "a terminal ambiguous failure",
      async (fetch) => {
        const solwyn = new Solwyn(client(failing(503)), {
          apiKey: API_KEY,
          fetch,
          provider: "openai",
        });
        await expect(chat(solwyn, BODY)).rejects.toMatchObject({ status: 503 });
        await solwyn.close();
      },
    ],
    [
      "an unrecognized failure after dispatch",
      async (fetch) => {
        const create = vi.fn((_kwargs: Body) => {
          throw new Error("synthetic unrecognized failure");
        });
        const solwyn = new Solwyn(client(create), { apiKey: API_KEY, fetch, provider: "openai" });
        await expect(chat(solwyn, BODY)).rejects.toThrow("synthetic unrecognized failure");
        await solwyn.close();
      },
    ],
    [
      "a caller abort without proof",
      async (fetch) => {
        const controller = new AbortController();
        const native = new OpenAI({
          apiKey: "sk-test",
          maxRetries: 0,
          fetch: async () => {
            controller.abort();
            throw Object.assign(new Error("synthetic abort"), { name: "AbortError" });
          },
        });
        const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
        await expect(
          (
            solwyn as unknown as {
              chat: { completions: { create(b: Body, o: unknown): Promise<unknown> } };
            }
          ).chat.completions.create(BODY, { signal: controller.signal }),
        ).rejects.toThrow();
        await solwyn.close();
      },
    ],
    [
      "a Responses stream entry failure",
      async (fetch) => {
        const native = new OpenAI({
          apiKey: "sk-test",
          maxRetries: 0,
          fetch: async () =>
            Response.json({ error: { message: "synthetic", type: "synthetic" } }, { status: 500 }),
        });
        const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
        const responses = (
          solwyn as unknown as { responses: { stream(b: Body): { done(): Promise<unknown> } } }
        ).responses;
        await expect(
          responses.stream({ model: "fallback-model", input: [], max_output_tokens: 128 }).done(),
        ).rejects.toMatchObject({ status: 500 });
        await solwyn.close();
      },
    ],
  ];

  describe.each([
    ["per-call", false],
    ["lease", true],
  ] as const)("%s", (_label, leased) => {
    it.each(paths)("after %s", async (_path, act) => {
      const stub = tightPlane(leased);
      if (leased) await run("floor-lease", () => act(stub.fetch));
      else await act(stub.fetch);

      const floors = stub.confirms.filter(
        (confirm) => (confirm["token_details"] as Body)["is_estimated"] === true,
      );
      expect(floors).toHaveLength(1);
      expect(floors[0]).toMatchObject({
        ...(leased ? { lease_id: "lease-floor" } : { reservation_id: "res-1" }),
        model: "fallback-model",
        provider: "openai",
        token_details: { input_tokens: expect.any(Number), output_tokens: 128 },
      });
      if (leased && STREAM_PATHS.has(_path)) {
        // A stream's floor-funded event is queued apart from its confirm and keeps the lease id.
        const attempt = stub.events.filter((event) => event["call_id"] === floors[0]?.["call_id"]);
        expect(attempt).not.toHaveLength(0);
        for (const event of attempt) expect(event["lease_id"]).toBe("lease-floor");
      }
      await nextCallIsDenied(stub);
    });
  });

  describe.each([
    ["per-call", false],
    ["lease", true],
  ] as const)("AI SDK middleware, %s", (_label, leased) => {
    const ambiguous = () => Object.assign(new Error("synthetic ambiguity"), { status: 503 });
    it.each([
      "generate",
      "establishment",
      "midstream",
      "cancel",
    ] as const)("after a %s outcome", async (stage) => {
      const stub = tightPlane(leased);
      const native = new MockLanguageModelV3({
        provider: "openai.chat",
        modelId: "fallback-model",
        doGenerate: async () => {
          throw ambiguous();
        },
        doStream: async () => {
          if (stage === "establishment") throw ambiguous();
          let index = 0;
          return {
            stream: new ReadableStream({
              pull(controller) {
                if (index++ === 0 || stage === "cancel")
                  controller.enqueue({ type: "text-delta", id: "synthetic", delta: "synthetic" });
                else controller.error(ambiguous());
              },
            }),
          };
        },
      });
      const handle = createSolwynMiddleware({ apiKey: API_KEY, fetch: stub.fetch });
      const model = wrapLanguageModel({ model: native, middleware: handle.middleware });
      const act = async () => {
        if (stage === "generate") {
          await expect(model.doGenerate({ prompt: [], maxOutputTokens: 128 })).rejects.toThrow();
          return;
        }
        if (stage === "establishment") {
          await expect(model.doStream({ prompt: [], maxOutputTokens: 128 })).rejects.toThrow();
          return;
        }
        const result = await model.doStream({ prompt: [], maxOutputTokens: 128 });
        const reader = result.stream.getReader();
        await reader.read();
        if (stage === "cancel") await reader.cancel();
        else await expect(reader.read()).rejects.toThrow();
      };
      if (leased) await run("floor-middleware", act);
      else await act();
      await handle.close();

      const floors = stub.confirms.filter(
        (confirm) => (confirm["token_details"] as Body)["is_estimated"] === true,
      );
      expect(floors).toHaveLength(1);
      expect(floors[0]).toMatchObject({
        ...(leased ? { lease_id: "lease-floor" } : { reservation_id: "res-1" }),
        model: "fallback-model",
        token_details: { output_tokens: 128 },
      });
      if (leased) {
        const attempt = stub.events.filter((event) => event["call_id"] === floors[0]?.["call_id"]);
        expect(attempt).not.toHaveLength(0);
        for (const event of attempt) expect(event["lease_id"]).toBe("lease-floor");
      }
      await nextCallIsDenied(stub);
    });
  });
});

describe("floor follow-ups", () => {
  it("confirms a completed call's estimated usage as before, not its floor", async () => {
    const stub = plane(1);
    const create = vi.fn((_kwargs: Body) => ({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    }));
    const solwyn = new Solwyn(client(create), {
      apiKey: API_KEY,
      fetch: stub.fetch,
      provider: "openai",
    });
    await chat(solwyn, { model: "fallback-model", messages: MESSAGES, max_tokens: 128 });
    await solwyn.close();

    // A completed call has a response, so its usage is estimated from it, not floored.
    expect(stub.confirms).toHaveLength(1);
    expect(stub.confirms[0]).toMatchObject({
      reservation_id: "res-1",
      token_details: { is_estimated: true },
    });
    expect((stub.confirms[0]?.["token_details"] as Body)["output_tokens"]).toBeLessThan(128);
  });

  it("raises a middleware stream floor to the usage the stream already reported", async () => {
    const stub = plane(1);
    const native = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "fallback-model",
      doStream: async () => {
        let index = 0;
        return {
          stream: new ReadableStream({
            pull(controller) {
              if (index++ === 0)
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                });
              else controller.error(Object.assign(new Error("synthetic"), { status: 503 }));
            },
          }),
        };
      },
    });
    const handle = createSolwynMiddleware({ apiKey: API_KEY, fetch: stub.fetch });
    const model = wrapLanguageModel({ model: native, middleware: handle.middleware });
    const result = await model.doStream({ prompt: [], maxOutputTokens: 128 });
    const reader = result.stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow();
    await handle.close();

    expect(stub.confirms).toMatchObject([
      { token_details: { input_tokens: 500, output_tokens: 128, is_estimated: true } },
    ]);
  });

  describe.each([
    ["per-call", false],
    ["lease", true],
  ] as const)("a middleware stream floor, %s", (_label, leased) => {
    it.each([
      "error",
      "cancel",
    ] as const)("is raised only by reported usage, not character estimates, after a %s", async (ending) => {
      const stub = leased ? finalLeasePlane() : plane(1);
      const native = new MockLanguageModelV3({
        provider: "openai.chat",
        modelId: "fallback-model",
        doStream: async () => {
          let index = 0;
          return {
            stream: new ReadableStream({
              pull(controller) {
                const step = index++;
                // 1,024 characters estimate to 256 output tokens, twice the 128-token bound.
                if (step === 0 || ending === "cancel")
                  controller.enqueue({
                    type: "text-delta",
                    id: "synthetic",
                    delta: "x".repeat(1024),
                  });
                else if (step === 1)
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
                    },
                  });
                else controller.error(Object.assign(new Error("synthetic"), { status: 503 }));
              },
            }),
          };
        },
      });
      const handle = createSolwynMiddleware({ apiKey: API_KEY, fetch: stub.fetch });
      const model = wrapLanguageModel({ model: native, middleware: handle.middleware });
      const act = async () => {
        const result = await model.doStream({ prompt: [], maxOutputTokens: 128 });
        const reader = result.stream.getReader();
        await reader.read();
        if (ending === "cancel") {
          await reader.cancel();
          return;
        }
        await reader.read();
        await expect(reader.read()).rejects.toThrow();
      };
      if (leased) await run("floor-chars", act);
      else await act();
      await handle.close();

      expect(stub.confirms).toMatchObject([
        {
          ...(leased ? { lease_id: "lease-r3" } : { reservation_id: "res-1" }),
          token_details: {
            ...(ending === "error" ? { input_tokens: 500 } : {}),
            output_tokens: 128,
            is_estimated: true,
          },
        },
      ]);
    });
  });

  it.each([
    ["per-call", false],
    ["lease", true],
  ] as const)("settles a %s stream that reached [DONE] at its usage when the caller aborts during cleanup", async (_label, leased) => {
    const stub = leased ? finalLeasePlane() : plane(1);
    const caller = new AbortController();
    const native = new OpenAI({
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async () => {
        const usageChunk = {
          id: "chatcmpl-r3",
          object: "chat.completion.chunk",
          created: 1,
          model: "fallback-model",
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        };
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(sseChunk("fallback-model", "synthetic"));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            },
            // OpenAI cancels the still-open body after [DONE]; the caller aborts meanwhile.
            cancel() {
              caller.abort();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const act = async () => {
      const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch });
      const stream = await (
        solwyn as unknown as {
          chat: { completions: { create(b: Body, o: unknown): Promise<unknown> } };
        }
      ).chat.completions.create(
        { model: "fallback-model", messages: MESSAGES, max_tokens: 128, stream: true },
        { signal: caller.signal },
      );
      for await (const _chunk of stream as AsyncIterable<unknown>) {
        // Drain to the provider's end.
      }
      await solwyn.close();
    };
    if (leased) await run("floor-done-abort", act);
    else await act();

    expect(caller.signal.aborted).toBe(true);
    expect(stub.confirms).toMatchObject([
      {
        ...(leased ? { lease_id: "lease-r3" } : { reservation_id: "res-1" }),
        token_details: { input_tokens: 2, output_tokens: 3 },
      },
    ]);
    // A completed settle at reported usage, not an estimated floor.
    expect((stub.confirms[0]?.["token_details"] as Body)["is_estimated"]).not.toBe(true);
  });

  it.each([
    ["per-call", false],
    ["lease", true],
  ] as const)("floors a %s stream aborted after interim usage with no finish reason", async (_label, leased) => {
    const stub = leased ? finalLeasePlane() : plane(1);
    const caller = new AbortController();
    const native = new OpenAI({
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
        // Continuous usage stats: every content chunk carries usage, none carries a finish reason.
        const interim = {
          id: "chatcmpl-r3",
          object: "chat.completion.chunk",
          created: 1,
          model: "fallback-model",
          choices: [{ index: 0, delta: { content: "synthetic" }, finish_reason: null }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        };
        return new Response(
          new ReadableStream({
            start(controller) {
              const signal = init?.signal;
              signal?.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
            pull(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(interim)}\n\n`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const act = async () => {
      const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch });
      const stream = await (
        solwyn as unknown as {
          chat: { completions: { create(b: Body, o: unknown): Promise<unknown> } };
        }
      ).chat.completions.create(
        { model: "fallback-model", messages: MESSAGES, max_tokens: 128, stream: true },
        { signal: caller.signal },
      );
      const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await iterator.next();
      caller.abort();
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await solwyn.close();
    };
    if (leased) await run("floor-interim-abort", act);
    else await act();

    expect(stub.confirms).toMatchObject([
      {
        ...(leased ? { lease_id: "lease-r3" } : { reservation_id: "res-1" }),
        token_details: { input_tokens: 2, output_tokens: 128, is_estimated: true },
      },
    ]);
  });

  it.each([
    ["per-call", false],
    ["lease", true],
  ] as const)("floors a %s n: 2 stream aborted after only one choice finished", async (_label, leased) => {
    // Two choices reserve 256 output tokens, more than the default 200-token grant.
    const stub = leased ? finalLeasePlane(1_000) : plane(1);
    const caller = new AbortController();
    const native = new OpenAI({
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
        // Choice 0 has finished; choice 1 is still generating. Usage is interim.
        const interim = {
          id: "chatcmpl-r3",
          object: "chat.completion.chunk",
          created: 1,
          model: "fallback-model",
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
            { index: 1, delta: { content: "synthetic" }, finish_reason: null },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        };
        return new Response(
          new ReadableStream({
            start(controller) {
              const signal = init?.signal;
              signal?.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
            pull(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(interim)}\n\n`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const act = async () => {
      const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch: stub.fetch });
      const stream = await (
        solwyn as unknown as {
          chat: { completions: { create(b: Body, o: unknown): Promise<unknown> } };
        }
      ).chat.completions.create(
        { model: "fallback-model", messages: MESSAGES, max_tokens: 128, n: 2, stream: true },
        { signal: caller.signal },
      );
      const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await iterator.next();
      caller.abort();
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await solwyn.close();
    };
    if (leased) await run("floor-n2-abort", act);
    else await act();

    expect(stub.confirms).toMatchObject([
      {
        ...(leased ? { lease_id: "lease-r3" } : { reservation_id: "res-1" }),
        token_details: { input_tokens: 2, output_tokens: 256, is_estimated: true },
      },
    ]);
  });

  it("floors the multi-generation guard's paid generation and keeps it past expiry", async () => {
    // One gemini floor (its 4096-token bound) fits; a second call does not.
    const stub = plane(6_000 / 1_000_000);
    RATES["gemini-2.5-flash"] = { input: 0, output: 1 / 1_000_000 };
    const generateContent = vi.fn(async (params: Body) => {
      const fetch = ((params["config"] as Body)["httpOptions"] as Body)["fetch"] as (
        url: string,
        init: unknown,
      ) => Promise<Response>;
      for (let round = 0; round < 2; round++) {
        await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          { body: JSON.stringify({ generationConfig: { maxOutputTokens: 4096 } }) },
        );
      }
      return { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    });
    vi.stubGlobal("fetch", async () => Response.json({}));
    const google = (target: unknown) =>
      new Solwyn(target, {
        apiKey: API_KEY,
        fetch: stub.fetch,
        leaseEnabled: false,
      }) as unknown as {
        models: { generateContent(p: Body): Promise<unknown> };
        close(): Promise<void>;
      };
    try {
      const solwyn = google({ models: { generateContent, generateContentStream: vi.fn() } });
      await expect(
        solwyn.models.generateContent({ model: "gemini-2.5-flash", contents: "synthetic" }),
      ).rejects.toMatchObject({ reason: "multi_generation_loop" });
      await solwyn.close();

      const bound = stub.checks[0]?.["estimated_output_bound"];
      expect(stub.confirms).toMatchObject([
        {
          reservation_id: "res-1",
          model: "gemini-2.5-flash",
          provider: "google",
          token_details: { output_tokens: bound, is_estimated: true },
        },
      ]);
      stub.expire();
      stub.reconcile();
      const next = google({
        models: {
          generateContent: vi.fn(async () => ({
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          })),
          generateContentStream: vi.fn(),
        },
      });
      await expect(
        next.models.generateContent({ model: "gemini-2.5-flash", contents: "synthetic" }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      await next.close();
    } finally {
      vi.unstubAllGlobals();
      delete RATES["gemini-2.5-flash"];
    }
  });
});
