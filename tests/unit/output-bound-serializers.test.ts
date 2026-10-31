/**
 * Under hard_deny admission the SDK either makes the reserved output bound true on the wire or
 * refuses the call before any provider I/O with `OutputBoundUnenforceableError`. These cases run
 * the real provider SDK serializers (OpenAI, Azure OpenAI, Google GenAI, Bedrock Runtime) on
 * mock transports and assert on the request body each SDK would send. Fully offline.
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GoogleGenAI } from "@google/genai";
import OpenAI, { AzureOpenAI } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputBoundUnenforceableError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import type { FetchLike } from "../../src/transport";
import type { BudgetMode } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;

type Body = Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function plane(mode: BudgetMode = "hard_deny") {
  const checks: Body[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("/api/v1/budgets/check")) {
      checks.push(JSON.parse(String(init?.body)) as Body);
      return Response.json({
        allowed: true,
        remaining_budget: 950,
        reservation_id: null,
        mode,
        budget_limit: 1000,
        current_usage: 50,
        denied_by_period: null,
        project_id: PROJECT_ID,
        price_hints: null,
      });
    }
    return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
  };
  return { fetch, checks };
}

const CHAT_COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** A real OpenAI-SDK client whose HTTP bodies are captured. */
function openaiTransport() {
  const bodies: Body[] = [];
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return Response.json(CHAT_COMPLETION);
  };
  return { bodies, fetch };
}

function chat(solwyn: unknown, body: Body): Promise<unknown> {
  return (
    solwyn as { chat: { completions: { create(b: Body): Promise<unknown> } } }
  ).chat.completions.create(body);
}

async function refusal(call: Promise<unknown>): Promise<OutputBoundUnenforceableError> {
  const error = await call.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OutputBoundUnenforceableError);
  return error as OutputBoundUnenforceableError;
}

const MESSAGES = [{ role: "user", content: "synthetic" }];

describe("Qwen: the reasoning budget sits outside max_tokens", () => {
  function qwen() {
    const transport = openaiTransport();
    const client = new OpenAI({
      apiKey: "sk-test",
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      fetch: transport.fetch,
    });
    return { client, ...transport };
  }

  it("adds thinking_budget to the bound and caps the answer", async () => {
    const { client, bodies } = qwen();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await chat(solwyn, {
      model: "qwen3.5-plus",
      messages: MESSAGES,
      enable_thinking: true,
      thinking_budget: 12_000,
    });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(4096 + 12_000);
    expect(bodies[0]).toMatchObject({ max_tokens: 4096, thinking_budget: 12_000 });
  });

  it("refuses default thinking with no budget before the provider is called", async () => {
    const { client, bodies } = qwen();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(chat(solwyn, { model: "qwen3.5-plus", messages: MESSAGES }));
    await solwyn.close();
    expect(error).toMatchObject({
      code: "output_bound_unenforceable",
      reason: "reasoning_without_budget",
      provider: "qwen",
    });
    expect(checks).toHaveLength(1);
    expect(bodies).toHaveLength(0);
  });

  it("bounds a call with thinking turned off at its cap", async () => {
    const { client, bodies } = qwen();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await chat(solwyn, { model: "qwen3.5-plus", messages: MESSAGES, enable_thinking: false });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(4096);
    expect(bodies[0]).toMatchObject({ max_tokens: 4096, enable_thinking: false });
  });

  it("counts the budget for an explicit max_completion_tokens the compat profile sends as max_tokens", async () => {
    const { client, bodies } = qwen();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await chat(solwyn, {
      model: "qwen3.5-plus",
      messages: MESSAGES,
      max_completion_tokens: 4096,
      thinking_budget: 12_000,
    });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(16_096);
    expect(bodies[0]).toMatchObject({ max_tokens: 4096, thinking_budget: 12_000 });
  });

  it("sends an alert-only call exactly as built", async () => {
    const { client, bodies } = qwen();
    const { fetch } = plane("alert_only");
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await chat(solwyn, { model: "qwen3.5-plus", messages: MESSAGES });
    await solwyn.close();
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });
});

describe("xAI: reasoning is outside max_completion_tokens and has no budget", () => {
  function xai() {
    const transport = openaiTransport();
    const client = new OpenAI({
      apiKey: "sk-test",
      baseURL: "https://api.x.ai/v1",
      fetch: transport.fetch,
    });
    return { client, ...transport };
  }

  it("refuses a reasoning model", async () => {
    const { client, bodies } = xai();
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      chat(solwyn, { model: "grok-4", messages: MESSAGES, max_completion_tokens: 100 }),
    );
    await solwyn.close();
    expect(error.reason).toBe("reasoning_without_budget");
    expect(bodies).toHaveLength(0);
  });

  it("caps a non-reasoning model", async () => {
    const { client, bodies } = xai();
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await chat(solwyn, { model: "grok-4-fast-non-reasoning", messages: MESSAGES });
    await solwyn.close();
    expect(bodies[0]).toMatchObject({ max_tokens: 4096 });
  });
});

describe("candidates multiply the bound", () => {
  it("OpenAI n x max_tokens", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(new OpenAI({ apiKey: "sk-test", fetch: transport }), {
      apiKey: API_KEY,
      fetch,
    });
    await chat(solwyn, { model: "gpt-4o", messages: MESSAGES, n: 2, max_tokens: 500 });
    await chat(solwyn, { model: "gpt-4o", messages: MESSAGES, n: 2 });
    await solwyn.close();
    expect(checks.map((check) => check["estimated_output_bound"])).toEqual([1000, 8192]);
    expect(bodies[0]).toMatchObject({ n: 2, max_tokens: 500 });
    expect(bodies[1]).toMatchObject({ n: 2, max_tokens: 4096 });
  });

  it("refuses a malformed OpenAI n", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const { fetch } = plane();
    const solwyn = new Solwyn(new OpenAI({ apiKey: "sk-test", fetch: transport }), {
      apiKey: API_KEY,
      fetch,
    });
    const error = await refusal(chat(solwyn, { model: "gpt-4o", messages: MESSAGES, n: 0 }));
    await solwyn.close();
    expect(error.reason).toBe("malformed_candidate_count");
    expect(bodies).toHaveLength(0);
  });

  it("Google candidateCount x maxOutputTokens", async () => {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    });
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
    });
    await solwyn.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "synthetic",
      config: { candidateCount: 2, maxOutputTokens: 500 },
    });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(1000);
    expect(bodies[0]?.["generationConfig"]).toMatchObject({
      candidateCount: 2,
      maxOutputTokens: 500,
    });
  });
});

describe("Google: containers and client overrides", () => {
  function googleFetch() {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    });
    return bodies;
  }

  it.each([17, [], "malformed"])("refuses config=%j", async (config) => {
    const bodies = googleFetch();
    const { fetch } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
    });
    const error = await refusal(
      solwyn.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "synthetic",
        config: config as never,
      }),
    );
    await solwyn.close();
    expect(error.reason).toBe("malformed_cap_container");
    expect(bodies).toHaveLength(0);
  });

  it("refuses a client-level extraBody that can rewrite generationConfig", async () => {
    const bodies = googleFetch();
    const { fetch } = plane();
    const native = new GoogleGenAI({
      apiKey: "test-key",
      httpOptions: { extraBody: { generationConfig: { maxOutputTokens: 9000 } } },
    });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    const error = await refusal(
      solwyn.models.generateContent({ model: "gemini-2.5-flash", contents: "synthetic" }),
    );
    await solwyn.close();
    expect(error.reason).toBe("client_body_override");
    expect(bodies).toHaveLength(0);
  });

  it("caps on the wire when a client extraBody leaves generationConfig alone", async () => {
    const bodies = googleFetch();
    const { fetch } = plane();
    const native = new GoogleGenAI({
      apiKey: "test-key",
      httpOptions: { extraBody: { labels: { team: "synthetic" } } },
    });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    await solwyn.models.generateContent({ model: "gemini-2.5-flash", contents: "synthetic" });
    await solwyn.close();
    expect(bodies[0]?.["generationConfig"]).toEqual({ maxOutputTokens: 4096 });
  });
});

describe("Bedrock: containers and model-native overrides", () => {
  function bedrock() {
    const bodies: Body[] = [];
    const client = new BedrockRuntimeClient({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret-test" },
      requestHandler: {
        handle: async (request: { body?: unknown }) => {
          bodies.push(JSON.parse(String(request.body)) as Body);
          return {
            response: {
              statusCode: 200,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(
                JSON.stringify({
                  output: { message: { role: "assistant", content: [{ text: "ok" }] } },
                  stopReason: "end_turn",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  metrics: { latencyMs: 1 },
                }),
              ),
            },
          };
        },
      } as never,
    });
    return { client, bodies };
  }

  function send(solwyn: unknown, input: Body): Promise<unknown> {
    return (solwyn as { send(command: unknown): Promise<unknown> }).send(
      new ConverseCommand(input as never),
    );
  }

  const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
  const CONVERSE_MESSAGES = [{ role: "user", content: [{ text: "synthetic" }] }];

  it("caps an uncapped command on the wire", async () => {
    const { client, bodies } = bedrock();
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await send(solwyn, { modelId: MODEL, messages: CONVERSE_MESSAGES });
    await solwyn.close();
    expect(bodies[0]?.["inferenceConfig"]).toEqual({ maxTokens: 4096 });
  });

  it.each([[[]], [17]])("refuses inferenceConfig=%j", async (inferenceConfig) => {
    const { client, bodies } = bedrock();
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      send(solwyn, { modelId: MODEL, messages: CONVERSE_MESSAGES, inferenceConfig }),
    );
    await solwyn.close();
    expect(error.reason).toBe("malformed_cap_container");
    expect(bodies).toHaveLength(0);
  });

  it("refuses an additionalModelRequestFields token limit", async () => {
    const { client, bodies } = bedrock();
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      send(solwyn, {
        modelId: MODEL,
        messages: CONVERSE_MESSAGES,
        inferenceConfig: { maxTokens: 100 },
        additionalModelRequestFields: { max_tokens: 9000 },
      }),
    );
    await solwyn.close();
    expect(error.reason).toBe("client_body_override");
    expect(bodies).toHaveLength(0);
  });

  it("keeps a Claude thinking budget, which sits inside maxTokens", async () => {
    const { client, bodies } = bedrock();
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await send(solwyn, {
      modelId: MODEL,
      messages: CONVERSE_MESSAGES,
      additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } },
    });
    await solwyn.close();
    expect(bodies[0]).toMatchObject({ inferenceConfig: { maxTokens: 4096 } });
  });
});

describe("Azure: the deployment name never picks the cap parameter", () => {
  function azure(apiVersion: string) {
    const transport = openaiTransport();
    const client = new AzureOpenAI({
      apiKey: "test-key",
      endpoint: "https://synthetic.openai.azure.com",
      apiVersion,
      fetch: transport.fetch,
    });
    return { client, ...transport };
  }

  it("injects max_completion_tokens for an aliased deployment", async () => {
    const { client, bodies } = azure("2024-10-21");
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await chat(solwyn, { model: "prod-reasoning", messages: MESSAGES });
    await solwyn.close();
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 4096 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });

  it("refuses an uncapped call on an api-version without max_completion_tokens", async () => {
    const { client, bodies } = azure("2024-06-01");
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(chat(solwyn, { model: "prod-reasoning", messages: MESSAGES }));
    await solwyn.close();
    expect(error.reason).toBe("azure_api_version");
    expect(bodies).toHaveLength(0);
  });

  it("never rewrites an explicit max_completion_tokens to max_tokens", async () => {
    const { client, bodies } = azure("2024-06-01");
    const { fetch } = plane("alert_only");
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch,
      defaultParams: { max_tokens: 50 },
    });
    await chat(solwyn, { model: "prod-chat", messages: MESSAGES, max_completion_tokens: 300 });
    await solwyn.close();
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 300 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });
});

describe("the final request must fit the reservation", () => {
  it("refuses a cap above the wire maximum under hard_deny", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(new OpenAI({ apiKey: "sk-test", fetch: transport }), {
      apiKey: API_KEY,
      fetch,
    });
    const error = await refusal(
      chat(solwyn, { model: "gpt-4o", messages: MESSAGES, max_tokens: 200_000_001 }),
    );
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(100_000_000);
    expect(error.reason).toBe("bound_exceeded");
    expect(bodies).toHaveLength(0);
  });
});

describe("Google: the bound models the dispatch merge", () => {
  function googleFetch() {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    });
    return bodies;
  }

  it("a per-call config replaces the global config whole, in the bound and on the wire", async () => {
    const bodies = googleFetch();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
      defaultParams: { config: { maxOutputTokens: 10_000 } },
    });
    await solwyn.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "synthetic",
      config: { temperature: 0.2 },
    });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(4096);
    expect(bodies[0]?.["generationConfig"]).toEqual({ temperature: 0.2, maxOutputTokens: 4096 });
  });

  it("keeps a global cap when the call sets no config", async () => {
    const bodies = googleFetch();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
      defaultParams: { config: { maxOutputTokens: 10_000 } },
    });
    await solwyn.models.generateContent({ model: "gemini-2.5-flash", contents: "synthetic" });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(10_000);
    expect(bodies[0]?.["generationConfig"]).toEqual({ maxOutputTokens: 10_000 });
  });

  it("sends only the camelCase cap: a snake_case alias is not serialized or duplicated", async () => {
    const bodies = googleFetch();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
    });
    await solwyn.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "synthetic",
      config: { max_output_tokens: 9000 } as never,
    });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(4096);
    expect(bodies[0]?.["generationConfig"]).toEqual({ maxOutputTokens: 4096 });
  });

  it("leaves an explicit camelCase cap untouched", async () => {
    const bodies = googleFetch();
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
    });
    await solwyn.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "synthetic",
      config: { maxOutputTokens: 700 },
    });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(700);
    expect(bodies[0]?.["generationConfig"]).toEqual({ maxOutputTokens: 700 });
  });
});

describe("Azure: layered cap aliases", () => {
  it("keeps the highest layer's key and prices it", async () => {
    const transport = openaiTransport();
    const client = new AzureOpenAI({
      apiKey: "test-key",
      endpoint: "https://synthetic.openai.azure.com",
      apiVersion: "2024-10-21",
      fetch: transport.fetch,
    });
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch,
      defaultParams: { max_completion_tokens: 50 },
    });
    await chat(solwyn, { model: "prod-chat", messages: MESSAGES, max_tokens: 300 });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(300);
    expect(transport.bodies[0]).toMatchObject({ max_tokens: 300 });
    expect(transport.bodies[0]).not.toHaveProperty("max_completion_tokens");
  });
});
