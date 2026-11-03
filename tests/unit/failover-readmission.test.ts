/**
 * Under hard_deny, a per-call check prices the primary model. A failover hop that serves a
 * different provider or model settles at its own price, so the SDK re-admits it first: the
 * superseded reservation is settled at zero usage, and the hop gets its own per-call check with
 * its own output bound. A hop that does not fit is refused before its provider is called.
 *
 * The stub control plane prices a reservation as input x input rate plus the output bound x
 * output rate per model (synthetic rates) and denies under hard_deny when it does not fit.
 */

import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { run } from "../../src/node";
import type { FetchLike } from "../../src/transport";
import type { BudgetMode } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;

type Body = Record<string, unknown>;

/** Synthetic per-token rates in dollars: a cheap primary and a much pricier fallback. */
const RATES: Record<string, { input: number; output: number }> = {
  "cheap-model": { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  "pricey-model": { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
  "other-cheap-model": { input: 0.1 / 1_000_000, output: 0.4 / 1_000_000 },
};

function pricingPlane(remaining: number, mode: BudgetMode = "hard_deny") {
  const checks: Body[] = [];
  const confirms: Body[] = [];
  const events: Body[] = [];
  let reservations = 0;
  const fetch: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      const check = body as Body;
      checks.push(check);
      const rate = RATES[check["model"] as string] ?? { input: 0, output: 0 };
      const reservation =
        (check["estimated_input_tokens"] as number) * rate.input +
        (check["estimated_output_bound"] as number) * rate.output;
      const allowed = mode === "alert_only" || reservation <= remaining;
      reservations += 1;
      return Response.json({
        allowed,
        remaining_budget: remaining,
        reservation_id: allowed ? `res-${reservations}` : null,
        mode,
        budget_limit: 0.01,
        current_usage: 0.01 - remaining,
        denied_by_period: allowed ? null : "monthly",
        project_id: PROJECT_ID,
        price_hints: null,
      });
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      confirms.push(body as Body);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(body)) {
      events.push(...(body as Body[]));
    }
    return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
  };
  return { fetch, checks, confirms, events };
}

const USAGE = { usage: { prompt_tokens: 3, completion_tokens: 2 } };

function failingPrimary() {
  return vi.fn((_kwargs: Body) => {
    throw Object.assign(new Error("primary rate limited"), { status: 429 });
  });
}

function chat(solwyn: unknown, body: Body): Promise<unknown> {
  return (
    solwyn as { chat: { completions: { create(b: Body): Promise<unknown> } } }
  ).chat.completions.create(body);
}

const REQUEST = { model: "cheap-model", messages: [{ role: "user", content: "hello" }] };

describe("hard_deny failover re-admits a hop priced differently from the primary", () => {
  it("refuses a pricier fallback that does not fit, before its provider is called", async () => {
    // $0.01 left: 4096 output tokens fit on the cheap primary (~$0.0025) but not the pricey
    // fallback (~$0.041).
    const plane = pricingPlane(0.01);
    const primary = failingPrimary();
    const fallback = vi.fn((_kwargs: Body) => USAGE);
    const solwyn = new Solwyn(
      { chat: { completions: { create: primary } } },
      {
        apiKey: API_KEY,
        fetch: plane.fetch,
        provider: "openai",
        fallback: [[{ chat: { completions: { create: fallback } } }, "pricey-model", {}, "openai"]],
      },
    );

    const error = await chat(solwyn, REQUEST).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    await solwyn.close();

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(plane.checks.map((check) => check["model"])).toEqual(["cheap-model", "pricey-model"]);
    expect(plane.checks[1]).toMatchObject({
      provider: "openai",
      estimated_output_bound: 4096,
      fallback_providers: [],
      fallback_models: [],
    });
    // The primary's reservation is settled at zero usage under a fresh call id.
    expect(plane.confirms).toHaveLength(1);
    expect(plane.confirms[0]).toMatchObject({
      reservation_id: "res-1",
      model: "cheap-model",
      token_details: { input_tokens: 0, output_tokens: 0 },
    });
    const statuses = plane.events.map((event) => [event["model"], event["status"]]);
    expect(statuses).toEqual([
      ["cheap-model", "error"],
      ["pricey-model", "budget_denied"],
    ]);
    expect(plane.confirms[0]?.["call_id"]).not.toBe(plane.events[0]?.["call_id"]);
  });

  it("serves a fallback that fits, reserved and settled at the hop's own price", async () => {
    const plane = pricingPlane(1);
    const primary = failingPrimary();
    const fallback = vi.fn((_kwargs: Body) => USAGE);
    const solwyn = new Solwyn(
      { chat: { completions: { create: primary } } },
      {
        apiKey: API_KEY,
        fetch: plane.fetch,
        provider: "openai",
        fallback: [
          [
            { chat: { completions: { create: fallback } } },
            "pricey-model",
            { max_tokens: 500 },
            "openai",
          ],
        ],
      },
    );

    await chat(solwyn, REQUEST);
    await solwyn.close();

    expect(fallback).toHaveBeenCalledOnce();
    // The hop's check carries the hop's own bound (its default cap), not the chain's largest.
    expect(plane.checks.map((check) => [check["model"], check["estimated_output_bound"]])).toEqual([
      ["cheap-model", 4096],
      ["pricey-model", 500],
    ]);
    expect(fallback.mock.calls[0]?.[0]).toMatchObject({ model: "pricey-model", max_tokens: 500 });
    const served = plane.confirms.find((confirm) => confirm["model"] === "pricey-model");
    expect(served).toMatchObject({ reservation_id: "res-2", is_provider_fallback: false });
    const success = plane.events.find((event) => event["status"] === "success");
    expect(served?.["call_id"]).toBe(success?.["call_id"]);
    expect(plane.confirms.find((confirm) => confirm["model"] === "cheap-model")).toMatchObject({
      reservation_id: "res-1",
      token_details: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it("re-admits a cross-provider hop and caps it like a primary", async () => {
    const plane = pricingPlane(1);
    const primary = failingPrimary();
    const anthropic = vi.fn((_kwargs: Body) => ({ usage: { input_tokens: 3, output_tokens: 2 } }));
    const solwyn = new Solwyn(
      { chat: { completions: { create: primary } } },
      {
        apiKey: API_KEY,
        fetch: plane.fetch,
        provider: "openai",
        fallback: [[{ messages: { create: anthropic } }, "pricey-model", {}, "anthropic"]],
      },
    );

    await chat(solwyn, { ...REQUEST, max_tokens: 200 });
    await solwyn.close();

    expect(plane.checks.map((check) => [check["provider"], check["model"]])).toEqual([
      ["openai", "cheap-model"],
      ["anthropic", "pricey-model"],
    ]);
    expect(anthropic.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 200 });
  });

  it("keeps a single check when the call is served by the primary", async () => {
    const plane = pricingPlane(1);
    const primary = vi.fn((_kwargs: Body) => USAGE);
    const solwyn = new Solwyn(
      { chat: { completions: { create: primary } } },
      {
        apiKey: API_KEY,
        fetch: plane.fetch,
        provider: "openai",
        fallback: [[{ chat: { completions: { create: vi.fn() } } }, "pricey-model", {}, "openai"]],
      },
    );

    await chat(solwyn, REQUEST);
    await solwyn.close();

    expect(plane.checks).toHaveLength(1);
    expect(plane.confirms).toHaveLength(1);
  });

  it("does not re-check an alert-only failover", async () => {
    const plane = pricingPlane(0.01, "alert_only");
    const primary = failingPrimary();
    const fallback = vi.fn((_kwargs: Body) => USAGE);
    const solwyn = new Solwyn(
      { chat: { completions: { create: primary } } },
      {
        apiKey: API_KEY,
        fetch: plane.fetch,
        provider: "openai",
        fallback: [[{ chat: { completions: { create: fallback } } }, "pricey-model", {}, "openai"]],
      },
    );

    await chat(solwyn, REQUEST);
    await solwyn.close();

    expect(fallback).toHaveBeenCalledOnce();
    expect(plane.checks).toHaveLength(1);
    expect(plane.confirms).toMatchObject([{ reservation_id: "res-1", model: "pricey-model" }]);
  });

  it("re-admits each further hop against the hop it replaces", async () => {
    const plane = pricingPlane(1);
    const primary = failingPrimary();
    const second = failingPrimary();
    const third = vi.fn((_kwargs: Body) => USAGE);
    const solwyn = new Solwyn(
      { chat: { completions: { create: primary } } },
      {
        apiKey: API_KEY,
        fetch: plane.fetch,
        provider: "openai",
        fallback: [
          [{ chat: { completions: { create: second } } }, "pricey-model", {}, "openai"],
          [{ chat: { completions: { create: third } } }, "other-cheap-model", {}, "openai"],
        ],
      },
    );

    await chat(solwyn, REQUEST);
    await solwyn.close();

    expect(plane.checks.map((check) => check["model"])).toEqual([
      "cheap-model",
      "pricey-model",
      "other-cheap-model",
    ]);
    expect(
      plane.confirms.map((confirm) => [
        confirm["reservation_id"],
        confirm["model"],
        (confirm["token_details"] as Body)["output_tokens"],
      ]),
    ).toEqual([
      ["res-1", "cheap-model", 0],
      ["res-2", "pricey-model", 0],
      ["res-3", "other-cheap-model", 2],
    ]);
  });

  it("leaves a lease-funded call alone: its lease is priced at the declared chain's worst rate", async () => {
    const grants: Body[] = [];
    const checks: Body[] = [];
    const leasePlane: FetchLike = async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/budgets/lease") {
        grants.push(JSON.parse(String(init?.body)) as Body);
        return Response.json({
          eligible: true,
          allowed: true,
          lease_id: "lease-chain",
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
        });
      }
      if (pathname.startsWith("/api/v1/budgets/lease/")) return new Response(null, { status: 204 });
      if (pathname === "/api/v1/budgets/check") {
        checks.push(JSON.parse(String(init?.body)) as Body);
        throw new TypeError("unexpected per-call check");
      }
      if (pathname === "/api/v1/budgets/confirm") return new Response(null, { status: 204 });
      return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
    };
    const primary = failingPrimary();
    const fallback = vi.fn((_kwargs: Body) => USAGE);
    const solwyn = new Solwyn(
      { chat: { completions: { create: primary } } },
      {
        apiKey: API_KEY,
        fetch: leasePlane,
        provider: "openai",
        fallback: [[{ chat: { completions: { create: fallback } } }, "pricey-model", {}, "openai"]],
      },
    );

    await run("failover-lease", () => chat(solwyn, REQUEST));
    await solwyn.close();

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ model: "cheap-model", fallback_models: ["pricey-model"] });
    expect(checks).toHaveLength(0);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
