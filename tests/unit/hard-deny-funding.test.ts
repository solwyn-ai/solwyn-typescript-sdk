/**
 * Review regressions for hard_deny funding across failover, the allow cache, leases, and
 * untracked surfaces with no output cap. The stub control plane keeps real holds: a check
 * reserves input x input rate plus the output bound x output rate, a confirm replaces its hold with
 * the settled cost, and hard_deny denies a reservation that does not fit the cap. Rates are
 * synthetic.
 */

import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  OutputBoundUnenforceableError,
  UntrackedSpendSurfaceError,
} from "../../src/errors";
import { Solwyn } from "../../src/index";
import { run } from "../../src/node";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
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
function plane(cap: number, lease?: LeaseSpec) {
  const checks: Body[] = [];
  const confirms: Body[] = [];
  const events: Body[] = [];
  const grants: Body[] = [];
  const surrenders: Body[] = [];
  const holds = new Map<string, number>();
  let spent = 0;
  let reservations = 0;
  const cost = (model: string, output: number) => output * (RATES[model]?.output ?? 0);
  const held = () => [...holds.values()].reduce((sum, value) => sum + value, 0);
  const fetch: FetchLike = async (url, init) => {
    const pathname = new URL(url).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (pathname === "/api/v1/budgets/lease" && lease !== undefined) {
      grants.push(body as Body);
      return Response.json(lease.grant);
    }
    if (pathname === "/api/v1/budgets/lease/surrender") {
      surrenders.push(body as Body);
      return Response.json({ lease_id: "", spent_tokens: 0, accepted: true });
    }
    if (pathname.startsWith("/api/v1/budgets/lease")) return new Response(null, { status: 204 });
    if (pathname === "/api/v1/budgets/check") {
      const check = body as Body;
      checks.push(check);
      const reserve = cost(check["model"] as string, check["estimated_output_bound"] as number);
      const allowed = spent + held() + reserve <= cap + 1e-12;
      const reservationId = allowed ? `res-${++reservations}` : null;
      if (reservationId !== null) holds.set(reservationId, reserve);
      return Response.json({
        allowed,
        remaining_budget: cap - spent - held(),
        reservation_id: reservationId,
        mode: "hard_deny",
        budget_limit: cap,
        current_usage: spent,
        denied_by_period: allowed ? null : "monthly",
        project_id: PROJECT_ID,
        price_hints: null,
      });
    }
    if (pathname === "/api/v1/budgets/confirm") {
      const confirm = body as Body;
      confirms.push(confirm);
      const reservationId = confirm["reservation_id"] as string | undefined;
      if (reservationId !== undefined) holds.delete(reservationId);
      const details = confirm["token_details"] as Body;
      spent += cost(confirm["model"] as string, details["output_tokens"] as number);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/v1/metadata/ingest" && Array.isArray(body)) events.push(...body);
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
    spent: () => spent,
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
    // The ambiguous hold (res-1) is never settled at zero; only the clean 429 hold is.
    expect(stub.confirms.map((confirm) => confirm["reservation_id"])).not.toContain("res-1");
    expect(stub.confirms).toMatchObject([
      { reservation_id: "res-2", token_details: { output_tokens: 0 } },
      { reservation_id: "res-3", model: "third-model", token_details: { output_tokens: 1000 } },
    ]);
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
    // The fallback is funded by its own per-call check, not by the possibly billed claim.
    expect(stub.checks.map((check) => check["model"])).toEqual(["fallback-model"]);
    expect(stub.confirms).toMatchObject([
      { reservation_id: "res-1", model: "fallback-model", token_details: { output_tokens: 128 } },
    ]);
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
