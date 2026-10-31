/**
 * The per-call budget check prices a text call's output at the same structural bound the lease
 * path reserves, and the SDK makes that bound true on the provider request.
 *
 * Every dialect sends `estimated_output_bound`: an explicit positive cap as is, otherwise the
 * configured default. Only a call admitted under hard_deny (a live or cached hard_deny allow, or a
 * lease with a hard_deny posture) gets that default injected as the dialect's max-output
 * parameter; alert_only and outage admissions dispatch the request exactly as built. The end to
 * end case runs against a stub control plane that prices a reservation the way Solwyn Cloud
 * does (input at the input rate plus the bound at the output rate) and refuses it in hard_deny.
 * Fully offline; rates are synthetic.
 */

import { describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { BudgetExceededError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { run } from "../../src/node";
import type { FetchLike } from "../../src/transport";
import type { BudgetMode } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const API_URL = "https://api.solwyn.test";
const PROJECT_ID = `proj_${"0".repeat(24)}`;

/** AWS SDK v3-shaped `ConverseCommand` (plain, AWS-import-free) dispatched via `send`. */
class ConverseCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

class BedrockRuntimeClient {
  readonly meta = {
    service_model: { service_name: "bedrock-runtime" },
    region_name: "us-east-1",
  };

  constructor(readonly send: ReturnType<typeof vi.fn>) {}
}

interface Plane {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  checks: Array<Record<string, unknown>>;
}

function allowPlane(mode: BudgetMode = "hard_deny"): Plane {
  const checks: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      checks.push(body as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: null,
          mode,
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: PROJECT_ID,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [], duplicates: [] }), {
      status: 202,
    });
  };
  return { fetchMock: vi.fn(impl), checks };
}

/**
 * A hard_deny project with `remaining` dollars. The reservation is input x input rate plus
 * `estimated_output_bound` x output rate; without the field it falls back to output == input.
 */
function pricedHardDenyPlane(remaining: number, inputRate: number, outputRate: number): Plane {
  const checks: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      const check = body as Record<string, unknown>;
      checks.push(check);
      const input = check["estimated_input_tokens"] as number;
      const bound = check["estimated_output_bound"];
      const output = typeof bound === "number" ? bound : input;
      const reservation = input * inputRate + output * outputRate;
      const allowed = reservation <= remaining;
      return new Response(
        JSON.stringify({
          allowed,
          remaining_budget: remaining,
          reservation_id: allowed ? "res-1" : null,
          mode: "hard_deny",
          budget_limit: 1,
          current_usage: 1 - remaining,
          denied_by_period: allowed ? null : "monthly",
          project_id: PROJECT_ID,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ingested: 0, rejected: [], duplicates: [] }), {
      status: 202,
    });
  };
  return { fetchMock: vi.fn(impl), checks };
}

type Request = Record<string, unknown>;

interface DialectCase {
  label: string;
  model: string;
  build: () => { client: unknown; call: ReturnType<typeof vi.fn> };
  /** Invoke the wrapped surface, with `cap` in the dialect's own cap field when defined. */
  invoke: (solwyn: unknown, model: string, cap: unknown) => Promise<unknown>;
  /** The dialect's cap as the provider received it. */
  sentCap: (request: Request) => unknown;
  /** Cap keys that must not appear on the provider request. */
  absentKeys?: readonly string[];
}

function chatCreate(solwyn: unknown, request: Request): Promise<unknown> {
  return (
    solwyn as { chat: { completions: { create(k: unknown): Promise<unknown> } } }
  ).chat.completions.create(request);
}

function withCap(request: Request, key: string, cap: unknown): Request {
  return cap === undefined ? request : { ...request, [key]: cap };
}

function firstArg(call: ReturnType<typeof vi.fn>): Request {
  return call.mock.calls[0]?.[0] as Request;
}

const CASES: DialectCase[] = [
  {
    label: "OpenAI chat (max_tokens)",
    model: "gpt-4o",
    build: () => {
      const call = vi.fn(() => ({ usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      return { client: { chat: { completions: { create: call } } }, call };
    },
    invoke: (solwyn, model, cap) =>
      chatCreate(solwyn, withCap({ model, messages: [] }, "max_tokens", cap)),
    sentCap: (request) => request["max_tokens"],
    absentKeys: ["max_completion_tokens"],
  },
  {
    label: "OpenAI reasoning chat (max_completion_tokens)",
    model: "o1-pro",
    build: () => {
      const call = vi.fn(() => ({ usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      return { client: { chat: { completions: { create: call } } }, call };
    },
    invoke: (solwyn, model, cap) =>
      chatCreate(solwyn, withCap({ model, messages: [] }, "max_completion_tokens", cap)),
    sentCap: (request) => request["max_completion_tokens"],
    absentKeys: ["max_tokens"],
  },
  {
    label: "OpenAI-compatible Groq (max_tokens)",
    model: "llama-3.3-70b-versatile",
    build: () => {
      const call = vi.fn(() => ({ usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      return {
        client: {
          chat: { completions: { create: call } },
          baseURL: "https://api.groq.com/openai/v1",
        },
        call,
      };
    },
    invoke: (solwyn, model, cap) =>
      chatCreate(solwyn, withCap({ model, messages: [] }, "max_tokens", cap)),
    sentCap: (request) => request["max_tokens"],
    absentKeys: ["max_completion_tokens"],
  },
  {
    label: "OpenAI Responses (max_output_tokens)",
    model: "gpt-4o",
    build: () => {
      const call = vi.fn(() => ({ usage: { input_tokens: 3, output_tokens: 2 } }));
      return {
        client: { chat: { completions: { create: vi.fn() } }, responses: { create: call } },
        call,
      };
    },
    invoke: (solwyn, model, cap) =>
      (solwyn as { responses: { create(k: unknown): Promise<unknown> } }).responses.create(
        withCap({ model, input: "hi" }, "max_output_tokens", cap),
      ),
    sentCap: (request) => request["max_output_tokens"],
  },
  {
    label: "Anthropic (max_tokens)",
    model: "claude-3-5-sonnet-20241022",
    build: () => {
      const call = vi.fn(() => ({ usage: { input_tokens: 3, output_tokens: 2 } }));
      return { client: { messages: { create: call } }, call };
    },
    invoke: (solwyn, model, cap) =>
      (solwyn as { messages: { create(k: unknown): Promise<unknown> } }).messages.create(
        withCap({ model, messages: [] }, "max_tokens", cap),
      ),
    sentCap: (request) => request["max_tokens"],
  },
  {
    label: "Google (config.maxOutputTokens)",
    model: "gemini-2.0-flash",
    build: () => {
      const call = vi.fn(() => ({
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      }));
      return {
        client: { models: { generateContent: call, generateContentStream: vi.fn() } },
        call,
      };
    },
    invoke: (solwyn, model, cap) =>
      (
        solwyn as { models: { generateContent(k: unknown): Promise<unknown> } }
      ).models.generateContent({
        model,
        contents: "hi",
        config:
          cap === undefined ? { temperature: 0.1 } : { temperature: 0.1, maxOutputTokens: cap },
      }),
    sentCap: (request) => (request["config"] as Request | undefined)?.["maxOutputTokens"],
  },
  {
    label: "Bedrock (inferenceConfig.maxTokens)",
    model: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    build: () => {
      const call = vi.fn((_command: unknown) => ({ usage: { inputTokens: 3, outputTokens: 2 } }));
      return { client: new BedrockRuntimeClient(call), call };
    },
    invoke: (solwyn, model, cap) =>
      (solwyn as { send(c: unknown): Promise<unknown> }).send(
        new ConverseCommand({
          modelId: model,
          messages: [],
          inferenceConfig:
            cap === undefined ? { temperature: 0.1 } : { temperature: 0.1, maxTokens: cap },
        }),
      ),
    sentCap: (command) =>
      ((command as { input: Request }).input["inferenceConfig"] as Request | undefined)?.[
        "maxTokens"
      ],
  },
];

describe("estimated_output_bound on the per-call check, per dialect", () => {
  for (const testCase of CASES) {
    it(`${testCase.label}: an explicit cap is the bound and reaches the provider as is`, async () => {
      const { client, call } = testCase.build();
      const { fetchMock, checks } = allowPlane();
      const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

      await testCase.invoke(solwyn, testCase.model, 777);
      await solwyn.close();

      expect(checks).toHaveLength(1);
      expect(checks[0]?.["estimated_output_bound"]).toBe(777);
      expect(call).toHaveBeenCalledOnce();
      expect(testCase.sentCap(firstArg(call))).toBe(777);
    });

    it(`${testCase.label}: alert_only sends the default bound but dispatches the request unchanged`, async () => {
      const { client, call } = testCase.build();
      const { fetchMock, checks } = allowPlane("alert_only");
      const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

      await testCase.invoke(solwyn, testCase.model, undefined);
      await testCase.invoke(solwyn, testCase.model, 0);
      await solwyn.close();

      // The second call replays the cached alert_only allow, which does not cap either.
      expect(checks).toHaveLength(1);
      expect(checks[0]?.["estimated_output_bound"]).toBe(4096);
      expect(testCase.sentCap(call.mock.calls[0]?.[0] as Request)).toBeUndefined();
      expect(testCase.sentCap(call.mock.calls[1]?.[0] as Request)).toBe(0);
      for (const key of testCase.absentKeys ?? []) {
        expect(call.mock.calls[0]?.[0]).not.toHaveProperty(key);
      }
    });

    it(`${testCase.label}: hard_deny admission sends the default bound and the provider gets it as its cap`, async () => {
      const { client, call } = testCase.build();
      const { fetchMock, checks } = allowPlane();
      const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

      await testCase.invoke(solwyn, testCase.model, undefined);
      await solwyn.close();

      expect(checks[0]?.["estimated_output_bound"]).toBe(4096);
      const sent = firstArg(call);
      expect(testCase.sentCap(sent)).toBe(4096);
      for (const key of testCase.absentKeys ?? []) expect(sent).not.toHaveProperty(key);
    });

    it(`${testCase.label}: a configured default replaces 4096, and a non-positive cap counts as uncapped`, async () => {
      const { client, call } = testCase.build();
      const { fetchMock, checks } = allowPlane();
      const solwyn = new Solwyn(client, {
        apiKey: API_KEY,
        fetch: fetchMock,
        leaseOutputBoundDefault: 1234,
      });

      await testCase.invoke(solwyn, testCase.model, 0);
      await solwyn.close();

      expect(checks[0]?.["estimated_output_bound"]).toBe(1234);
      expect(testCase.sentCap(firstArg(call))).toBe(1234);
    });
  }

  it("keeps the caller's Google config and Bedrock inferenceConfig keys when injecting", async () => {
    const google = CASES.find((c) => c.label.startsWith("Google")) as DialectCase;
    const bedrock = CASES.find((c) => c.label.startsWith("Bedrock")) as DialectCase;
    for (const testCase of [google, bedrock]) {
      const { client, call } = testCase.build();
      const { fetchMock } = allowPlane();
      const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
      await testCase.invoke(solwyn, testCase.model, undefined);
      await solwyn.close();
      const sent = firstArg(call);
      const container =
        testCase === google
          ? (sent["config"] as Request)
          : ((sent as unknown as { input: Request }).input["inferenceConfig"] as Request);
      expect(container).toMatchObject({ temperature: 0.1 });
    }
  });

  it("does not mutate the caller's Bedrock command when injecting the cap", async () => {
    const send = vi.fn((_command: unknown) => ({ usage: { inputTokens: 3, outputTokens: 2 } }));
    const { fetchMock } = allowPlane();
    const solwyn = new Solwyn(new BedrockRuntimeClient(send), {
      apiKey: API_KEY,
      fetch: fetchMock,
    });
    const command = new ConverseCommand({
      modelId: "meta.llama3-1-70b-instruct-v1:0",
      messages: [],
    });

    await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command);
    await solwyn.close();

    const served = send.mock.calls[0]?.[0] as ConverseCommand;
    expect(served).not.toBe(command);
    expect(served).toBeInstanceOf(ConverseCommand);
    expect(served.input["inferenceConfig"]).toEqual({ maxTokens: 4096 });
    expect(command.input).not.toHaveProperty("inferenceConfig");
  });

  it("bounds a failover chain by its largest hop cap and injects only on uncapped hops", async () => {
    const primaryError = Object.assign(new Error("primary unavailable"), { status: 429 });
    const primaryCreate = vi.fn((_kwargs: Request) => {
      throw primaryError;
    });
    const fallbackCreate = vi.fn((_kwargs: Request) => ({
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const { fetchMock, checks } = allowPlane();
    const solwyn = new Solwyn(
      { chat: { completions: { create: primaryCreate } } },
      {
        apiKey: API_KEY,
        fetch: fetchMock,
        provider: "openai",
        fallback: [
          [
            { chat: { completions: { create: fallbackCreate } } },
            "gpt-4o-mini",
            { max_tokens: 9000 },
            "openai",
          ],
        ],
      },
    );

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(checks[0]?.["estimated_output_bound"]).toBe(9000);
    expect(primaryCreate.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 4096 });
    expect(fallbackCreate.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 9000 });
  });

  it("caps a call admitted by a cached hard_deny allow", async () => {
    const create = vi.fn((_kwargs: Request) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock, checks } = allowPlane("hard_deny");
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      { apiKey: API_KEY, fetch: fetchMock },
    );

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(checks).toHaveLength(1);
    expect(create.mock.calls.map(([kwargs]) => kwargs["max_tokens"])).toEqual([4096, 4096]);
  });

  it("does not cap a fail-open outage admission, even with a hard_deny constructor mode", async () => {
    const create = vi.fn((_kwargs: Request) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const checks: Request[] = [];
    const unreachable: FetchLike = async (url, init) => {
      if (url.includes("/api/v1/budgets/check")) {
        checks.push(JSON.parse(String(init?.body)) as Request);
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ ingested: 0, rejected: [], duplicates: [] }), {
        status: 202,
      });
    };
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      { apiKey: API_KEY, fetch: unreachable, budgetMode: "hard_deny", failOpen: true },
    );

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(checks[0]?.["estimated_output_bound"]).toBe(4096);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
  });

  for (const posture of ["hard_deny", "alert_only"] as const) {
    it(`${posture === "hard_deny" ? "caps" : "does not cap"} a lease-funded call under a ${posture} lease posture`, async () => {
      const create = vi.fn((_kwargs: Request) => ({
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      const grants: Request[] = [];
      let perCallChecks = 0;
      const leasePlane: FetchLike = async (url, init) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/v1/budgets/lease") {
          grants.push(JSON.parse(String(init?.body)) as Request);
          return new Response(
            JSON.stringify({
              eligible: true,
              allowed: true,
              lease_id: "lease-output-bound",
              generation: 1,
              granted_tokens: 50_000,
              refresh_interval_s: 300,
              lease_length_s: 600,
              headroom_share_tokens: 5_000,
              posture: { mode: posture, on_unreachable: "fail_open" },
              final_grant: false,
              project_id: PROJECT_ID,
              mode: posture,
              budget_limit: 1_000,
              current_usage: 100,
              remaining_budget: 900,
            }),
            { status: 200 },
          );
        }
        if (pathname.startsWith("/api/v1/budgets/lease/"))
          return new Response(null, { status: 204 });
        if (pathname === "/api/v1/budgets/check") {
          perCallChecks += 1;
          throw new TypeError("unexpected per-call check");
        }
        if (pathname === "/api/v1/budgets/confirm") return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ ingested: 0, rejected: [], duplicates: [] }), {
          status: 202,
        });
      };
      const solwyn = new Solwyn(
        { chat: { completions: { create } } },
        { apiKey: API_KEY, fetch: leasePlane },
      );

      await run("output-bound-lease", () =>
        solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
      );
      await solwyn.close();

      expect(grants).toHaveLength(1);
      expect(perCallChecks).toBe(0);
      expect(create).toHaveBeenCalledOnce();
      if (posture === "hard_deny") {
        expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 4096 });
      } else {
        expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
      }
    });
  }

  it("sends a cap above the wire maximum as the maximum (alert_only sends the call as built)", async () => {
    const create = vi.fn((_kwargs: Request) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock, checks } = allowPlane("alert_only");
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      { apiKey: API_KEY, fetch: fetchMock },
    );

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      max_tokens: 200_000_001,
    });
    await solwyn.close();

    expect(checks[0]?.["estimated_output_bound"]).toBe(100_000_000);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 200_000_001 });
  });
});

describe("hard_deny refuses a call whose output bound exceeds the remaining budget", () => {
  // An o1-pro-like synthetic card: $150 per million input tokens, $600 per million output tokens.
  const INPUT_RATE = 150 / 1_000_000;
  const OUTPUT_RATE = 600 / 1_000_000;

  function o1ProClient() {
    const create = vi.fn((_kwargs: Request) => ({
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }));
    return { client: { chat: { completions: { create } } }, create };
  }

  it("refuses max_completion_tokens=10000 against $1.00 before the provider is called", async () => {
    const { client, create } = o1ProClient();
    const plane = pricedHardDenyPlane(1, INPUT_RATE, OUTPUT_RATE);
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: plane.fetchMock });

    await expect(
      solwyn.chat.completions.create({
        model: "o1-pro",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 10_000,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
    expect(plane.checks).toHaveLength(1);
    expect(plane.checks[0]?.["estimated_output_bound"]).toBe(10_000);
    // The same check without the bound is the legacy output == input estimate, which allows.
    const input = plane.checks[0]?.["estimated_input_tokens"] as number;
    expect(input * (INPUT_RATE + OUTPUT_RATE)).toBeLessThan(1);
  });

  it("refuses an uncapped call at the default bound, so it cannot outspend its reservation", async () => {
    const { client, create } = o1ProClient();
    const plane = pricedHardDenyPlane(1, INPUT_RATE, OUTPUT_RATE);
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: plane.fetchMock });

    await expect(
      solwyn.chat.completions.create({
        model: "o1-pro",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
    expect(plane.checks[0]?.["estimated_output_bound"]).toBe(4096);
  });

  it("allows a small explicit cap that fits the remaining budget", async () => {
    const { client, create } = o1ProClient();
    const plane = pricedHardDenyPlane(1, INPUT_RATE, OUTPUT_RATE);
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: plane.fetchMock });

    await solwyn.chat.completions.create({
      model: "o1-pro",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 100,
    });
    await solwyn.close();

    expect(plane.checks[0]?.["estimated_output_bound"]).toBe(100);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_completion_tokens: 100 });
  });
});

describe("BudgetEnforcer output bound", () => {
  it("defaults a missing or non-positive bound and omits it on media checks", () => {
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseOutputBoundDefault: 512,
    });
    const base = { estimatedInputTokens: 1, model: "m", provider: "openai" as const };

    expect(enforcer.buildCheckRequest(base).estimated_output_bound).toBe(512);
    expect(
      enforcer.buildCheckRequest({ ...base, estimatedOutputBound: 0 }).estimated_output_bound,
    ).toBe(512);
    expect(
      enforcer.buildCheckRequest({ ...base, estimatedOutputBound: 99 }).estimated_output_bound,
    ).toBe(99);
    expect(
      enforcer.buildCheckRequest({ ...base, modality: "text", estimatedOutputBound: 99 })
        .estimated_output_bound,
    ).toBe(99);
    expect(
      enforcer.buildCheckRequest({ ...base, modality: "image", estimatedOutputBound: 99 }),
    ).not.toHaveProperty("estimated_output_bound");
  });

  it("does not let a cached allow for a small bound admit a larger one", async () => {
    const plane = allowPlane();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: plane.fetchMock,
      leaseEnabled: false,
    });
    const base = { estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" as const };

    await enforcer.checkBudget({ ...base, estimatedOutputBound: 100 });
    await enforcer.checkBudget({ ...base, estimatedOutputBound: 100 });
    expect(plane.checks).toHaveLength(1);

    await enforcer.checkBudget({ ...base, estimatedOutputBound: 10_000 });
    expect(plane.checks).toHaveLength(2);
    expect(plane.checks[1]?.["estimated_output_bound"]).toBe(10_000);
    await enforcer.close();
  });
});

describe("the single-generation guard on an SDK-internal loop", () => {
  it("stops after one paid generation and records a possibly-succeeded error", async () => {
    const sent: unknown[] = [];
    const events: Request[] = [];
    // A Google-shaped client that loops through the per-request fetch, as an SDK-internal
    // continuation the request settings did not turn off would.
    const generateContent = vi.fn(async (params: Request) => {
      const fetch = ((params["config"] as Request)["httpOptions"] as Request)["fetch"] as (
        url: string,
        init: unknown,
      ) => Promise<Response>;
      for (let round = 0; round < 2; round++) {
        await fetch("https://generativelanguage.example/v1beta", { body: "{}" });
      }
      return { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    });
    vi.stubGlobal("fetch", async (url: unknown) => {
      sent.push(url);
      return Response.json({});
    });
    const planeFetch: FetchLike = async (url, init) => {
      if (url.includes("/api/v1/budgets/check")) {
        return Response.json({
          allowed: true,
          remaining_budget: 950,
          reservation_id: "res-guard",
          mode: "hard_deny",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: PROJECT_ID,
          price_hints: null,
        });
      }
      if (url.includes("/api/v1/metadata/ingest") && typeof init?.body === "string") {
        events.push(...(JSON.parse(init.body) as Request[]));
      }
      return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
    };
    const solwyn = new Solwyn(
      { models: { generateContent, generateContentStream: vi.fn() } },
      { apiKey: API_KEY, fetch: planeFetch, leaseEnabled: false },
    );
    const error = await (
      solwyn as unknown as { models: { generateContent(p: Request): Promise<unknown> } }
    ).models
      .generateContent({ model: "gemini-2.5-flash", contents: "synthetic" })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    await solwyn.close();
    vi.unstubAllGlobals();

    expect(error).toMatchObject({ reason: "multi_generation_loop" });
    expect(sent).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error", possibly_succeeded: true });
  });
});
