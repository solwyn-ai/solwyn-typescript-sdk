/**
 * End-to-end provider wiring: a wrapped, duck-typed Anthropic / Google / Bedrock /
 * OpenAI-compatible client dispatches through the FULL pipeline (budget pre-flight →
 * native dispatch → usage extraction → confirm + metadata reporting) with correct
 * provider name attribution on every wire message.
 *
 * This is the integration counterpart to `proxies.test.ts` (surface interception) and
 * `registry.test.ts` (detection/order). It uses the REAL adapter registry — no injected
 * stubs — with the Solwyn Cloud API `fetch` mocked to capture the budget-check request,
 * the confirm request, and the metadata event for each dialect. Every provider client is
 * a plain object shaped like the vendor SDK; no real provider SDK is imported. Fully
 * offline.
 */

import { describe, expect, it, vi } from "vitest";
import { Solwyn } from "../../src/index";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

/** AWS SDK v3-shaped `ConverseCommand` (plain, AWS-import-free) — dispatched via `send`. */
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

interface Capture {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  checks: Array<Record<string, unknown>>;
  confirms: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

/**
 * A cloud-API fetch that captures every budget-check request body, confirm request body,
 * and metadata event, and returns a valid ALLOW carrying a reservation id (so the
 * non-streaming confirm path fires and can be asserted too).
 */
function makeCaptureFetch(): Capture {
  const checks: Array<Record<string, unknown>> = [];
  const confirms: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      if (raw !== undefined) {
        checks.push(raw as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: "res-1",
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      if (raw !== undefined) {
        confirms.push(raw as Record<string, unknown>);
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
      events.push(...(raw as Array<Record<string, unknown>>));
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), checks, confirms, events };
}

/** One dialect's end-to-end case: how to build the client and how to invoke it. */
interface DialectCase {
  label: string;
  provider: string;
  model: string;
  /** Builds the duck-typed client + returns the provider-call spy for the assertion. */
  build: () => { client: unknown; call: ReturnType<typeof vi.fn> };
  /** Invokes the intercepted surface for this dialect on the wrapped Solwyn client. */
  invoke: (solwyn: unknown, model: string) => Promise<unknown>;
}

const CASES: DialectCase[] = [
  {
    label: "Anthropic (messages.create)",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    build: () => {
      const call = vi.fn(() => ({ usage: { input_tokens: 11, output_tokens: 7 } }));
      return { client: { messages: { create: call } }, call };
    },
    invoke: (solwyn, model) =>
      (solwyn as { messages: { create(k: unknown): Promise<unknown> } }).messages.create({
        model,
        messages: [{ role: "user", content: "hello there" }],
      }),
  },
  {
    label: "Google (models.generateContent)",
    provider: "google",
    model: "gemini-2.0-flash",
    build: () => {
      const call = vi.fn(() => ({
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      }));
      return {
        client: { models: { generateContent: call, generateContentStream: vi.fn() } },
        call,
      };
    },
    invoke: (solwyn, model) =>
      (
        solwyn as { models: { generateContent(k: unknown): Promise<unknown> } }
      ).models.generateContent({ model, contents: "hello there" }),
  },
  {
    label: "Bedrock (send ConverseCommand)",
    provider: "bedrock",
    model: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    build: () => {
      const call = vi.fn((_command: unknown) => ({ usage: { inputTokens: 15, outputTokens: 6 } }));
      return {
        client: new BedrockRuntimeClient(call),
        call,
      };
    },
    invoke: (solwyn, model) =>
      (solwyn as { send(c: unknown): Promise<unknown> }).send(
        new ConverseCommand({
          modelId: model,
          messages: [{ role: "user", content: [{ text: "hello there" }] }],
        }),
      ),
  },
  {
    label: "OpenAI-compatible / Groq (chat.completions.create)",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    build: () => {
      const call = vi.fn(() => ({ usage: { prompt_tokens: 8, completion_tokens: 5 } }));
      return {
        client: {
          chat: { completions: { create: call } },
          baseURL: "https://api.groq.com/openai/v1",
        },
        call,
      };
    },
    invoke: (solwyn, model) =>
      (
        solwyn as { chat: { completions: { create(k: unknown): Promise<unknown> } } }
      ).chat.completions.create({ model, messages: [{ role: "user", content: "hello there" }] }),
  },
];

describe("M3 provider wiring — dialect dispatch + NAME attribution (invariant 5)", () => {
  for (const testCase of CASES) {
    it(`${testCase.label} dispatches and attributes provider '${testCase.provider}' on check, confirm, and event`, async () => {
      const { client, call } = testCase.build();
      const { fetchMock, checks, confirms, events } = makeCaptureFetch();
      const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

      await testCase.invoke(solwyn, testCase.model);
      await solwyn.close();

      // The native provider method was actually dispatched to.
      expect(call).toHaveBeenCalledTimes(1);

      // Budget PRE-FLIGHT carries the served provider NAME + the per-call model.
      expect(checks).toHaveLength(1);
      expect(checks[0]?.["provider"]).toBe(testCase.provider);
      expect(checks[0]?.["model"]).toBe(testCase.model);
      // Primary-only chain: no fallbacks declared.
      expect(checks[0]?.["fallback_providers"]).toEqual([]);
      expect(checks[0]?.["fallback_models"]).toEqual([]);

      // The reservation confirm carries the same served provider NAME + model.
      expect(confirms).toHaveLength(1);
      expect(confirms[0]?.["provider"]).toBe(testCase.provider);
      expect(confirms[0]?.["model"]).toBe(testCase.model);

      // The durable metadata event carries the same served provider NAME + model.
      expect(events).toHaveLength(1);
      expect(events[0]?.["provider"]).toBe(testCase.provider);
      expect(events[0]?.["model"]).toBe(testCase.model);
      expect(events[0]?.["status"]).toBe("success");
      // Primary-served: never a model/provider fallback.
      expect(events[0]?.["is_model_fallback"]).toBe(false);
      expect(events[0]?.["is_provider_fallback"]).toBe(false);
    });
  }

  it("threads the same call_id across the check-driven confirm and the metadata event (Bedrock)", async () => {
    const bedrockCase = CASES.find((c) => c.provider === "bedrock") as DialectCase;
    const { client, call } = bedrockCase.build();
    const { fetchMock, confirms, events } = makeCaptureFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await bedrockCase.invoke(solwyn, bedrockCase.model);
    await solwyn.close();

    expect(call).toHaveBeenCalledTimes(1);
    expect(confirms).toHaveLength(1);
    expect(events).toHaveLength(1);
    // The confirm and its metadata event share the reconciliation join key.
    expect(confirms[0]?.["call_id"]).toBe(events[0]?.["call_id"]);
    // Bedrock is priced per (model, region): region rides both the confirm and the event.
    expect(confirms[0]?.["provider_region"]).toBe("us-east-1");
    expect(events[0]?.["provider_region"]).toBe("us-east-1");
  });

  it("attributes a same-dialect compat fallback by its own NAME in the budget check chain", async () => {
    // Primary OpenAI, fallback pointed at a DeepSeek baseURL (same openai dialect). The
    // budget check's fallback_providers must carry the compat NAME 'deepseek', not 'openai'.
    const primary = {
      chat: { completions: { create: vi.fn((_k: Record<string, unknown>) => ({ usage: {} })) } },
    };
    const fallback = {
      chat: { completions: { create: vi.fn() } },
      baseURL: "https://api.deepseek.com/v1",
    };
    const { fetchMock, checks } = makeCaptureFetch();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
    });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(checks).toHaveLength(1);
    expect(checks[0]?.["provider"]).toBe("openai");
    expect(checks[0]?.["fallback_providers"]).toEqual(["deepseek"]);
    expect(checks[0]?.["fallback_models"]).toEqual(["deepseek-chat"]);
  });

  it("dispatches the Google hop with the default constant 600000ms provider bound", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    // Pins the seconds-to-milliseconds unit across the client/adapter seam end to end. The client passes
    // immutable provider bound in SECONDS; the Google adapter converts to whole milliseconds ONCE.
    // The failover window does not shrink or cap the already-dispatched provider request.
    const generateContent = vi.fn((..._args: unknown[]) => ({
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    }));
    const client = { models: { generateContent, generateContentStream: vi.fn() } };
    const { fetchMock } = makeCaptureFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await (
      solwyn as unknown as { models: { generateContent(k: unknown): Promise<unknown> } }
    ).models.generateContent({ model: "gemini-2.0-flash", contents: "hello there" });
    await solwyn.close();

    const dispatched = generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const config = dispatched["config"] as Record<string, unknown>;
    const httpOptions = config["httpOptions"] as Record<string, unknown>;
    const retryOptions = httpOptions["retryOptions"] as Record<string, unknown>;
    expect(httpOptions["timeout"]).toBe(600_000);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 600_000);
    timer.mockRestore();
    // Provider transport retry is disabled: the original attempt is the only attempt.
    expect(retryOptions["attempts"]).toBe(1);
  });
});
