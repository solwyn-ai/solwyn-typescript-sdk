/**
 * Under hard_deny admission the SDK either makes the reserved output bound true on the wire or
 * refuses the call before any provider I/O with `OutputBoundUnenforceableError`. These cases run
 * the real provider SDK serializers (OpenAI, Azure OpenAI, Google GenAI, Bedrock Runtime) on
 * mock transports and assert on the request body each SDK would send. Fully offline.
 */

import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GoogleGenAI, mcpToTool } from "@google/genai";
import OpenAI, { AzureOpenAI } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputBoundUnenforceableError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { GoogleAdapter } from "../../src/providers/google";
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
    expect(error.reason).toBe("unsupported_override");
    expect(bodies).toHaveLength(0);
  });

  it.each([
    { generationConfig: { maxOutputTokens: 9000, candidateCount: 3 } },
    { generation_config: { max_output_tokens: 9000 } },
    { GenerationConfig: { maxOutputTokens: 9000 } },
    { labels: { team: "synthetic" } },
  ])("refuses any client-level extraBody key under hard_deny: %j", async (extraBody) => {
    const bodies = googleFetch();
    const { fetch } = plane();
    const native = new GoogleGenAI({ apiKey: "test-key", httpOptions: { extraBody } });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    const error = await refusal(
      solwyn.models.generateContent({ model: "gemini-2.5-flash", contents: "synthetic" }),
    );
    await solwyn.close();
    expect(error.reason).toBe("unsupported_override");
    expect(bodies).toHaveLength(0);
  });

  it("sends a client extraBody unchanged on an alert-only project", async () => {
    const bodies = googleFetch();
    const { fetch } = plane("alert_only");
    const native = new GoogleGenAI({
      apiKey: "test-key",
      httpOptions: { extraBody: { generationConfig: { candidateCount: 3 } } },
    });
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    await solwyn.models.generateContent({ model: "gemini-2.5-flash", contents: "synthetic" });
    await solwyn.close();
    expect(bodies[0]?.["generationConfig"]).toEqual({ candidateCount: 3 });
  });
});

describe("body extensions under hard_deny carry only allowlisted keys", () => {
  it.each([
    [
      "model override",
      "https://api.x.ai/v1",
      "grok-4-fast-non-reasoning",
      { model_override: "grok-4" },
    ],
    [
      "template kwargs",
      "https://api.together.xyz/v1",
      "Qwen/Qwen3-32B",
      { chat_template_kwargs: { enable_thinking: true } },
    ],
    [
      "provider reasoning",
      "https://openrouter.ai/api/v1",
      "openai/gpt-4o",
      { reasoning: { max_tokens: 9000 } },
    ],
  ])("refuses an untyped OpenAI chat body key (%s)", async (_label, baseURL, model, extension) => {
    const { bodies, fetch: transport } = openaiTransport();
    const { fetch } = plane();
    const solwyn = new Solwyn(new OpenAI({ apiKey: "sk-test", baseURL, fetch: transport }), {
      apiKey: API_KEY,
      fetch,
    });
    const error = await refusal(chat(solwyn, { model, messages: MESSAGES, ...extension }));
    await solwyn.close();
    expect(error.reason).toBe("unsupported_override");
    expect(bodies).toHaveLength(0);
  });

  it("keeps typed OpenAI params and sends an untyped key unchanged on alert-only", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const hard = plane();
    const typed = new Solwyn(new OpenAI({ apiKey: "sk-test", fetch: transport }), {
      apiKey: API_KEY,
      fetch: hard.fetch,
    });
    await chat(typed, {
      model: "gpt-4o",
      messages: MESSAGES,
      temperature: 0.1,
      seed: 1,
      user: "u",
    });
    await typed.close();
    const alert = plane("alert_only");
    const untyped = new Solwyn(new OpenAI({ apiKey: "sk-test", fetch: transport }), {
      apiKey: API_KEY,
      fetch: alert.fetch,
    });
    await chat(untyped, { model: "gpt-4o", messages: MESSAGES, custom_extension: true });
    await untyped.close();
    expect(bodies[0]).toMatchObject({ temperature: 0.1, seed: 1, max_tokens: 4096 });
    expect(bodies[1]).toMatchObject({ custom_extension: true });
    expect(bodies[1]).not.toHaveProperty("max_tokens");
  });

  it("refuses an untyped Anthropic messages body key", async () => {
    const bodies: Body[] = [];
    const client = new Anthropic({
      apiKey: "sk-ant-test",
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)) as Body);
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const messages = (solwyn as unknown as { messages: { create(b: Body): Promise<unknown> } })
      .messages;
    await messages.create({ model: "claude-sonnet-4-5", max_tokens: 100, messages: MESSAGES });
    const error = await refusal(
      messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        messages: MESSAGES,
        max_tokens_override: 9000,
      }),
    );
    await solwyn.close();
    expect(error.reason).toBe("unsupported_override");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ max_tokens: 100 });
  });

  it("refuses an untyped Responses body key", async () => {
    const bodies: Body[] = [];
    const client = new OpenAI({
      apiKey: "sk-test",
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)) as Body);
        return Response.json({});
      },
    });
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      solwyn.responses.create({ model: "gpt-4o", input: "synthetic", n: 2 } as never),
    );
    await solwyn.close();
    expect(error.reason).toBe("unsupported_override");
    expect(bodies).toHaveLength(0);
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

  it.each([
    [{ top_k: 5 }],
    [{ anthropic_beta: ["output-128k-2025-02-19"] }],
    [{ Thinking: { type: "enabled", budget_tokens: 1024 } }],
  ])("refuses additionalModelRequestFields outside the allowlist: %j", async (extra) => {
    const { client, bodies } = bedrock();
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      send(solwyn, {
        modelId: MODEL,
        messages: CONVERSE_MESSAGES,
        additionalModelRequestFields: extra,
      }),
    );
    await solwyn.close();
    expect(error.reason).toBe("unsupported_override");
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
    expect(error.reason).toBe("unsupported_override");
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

describe("client-level fetchOptions.body replaces the serialized body", () => {
  const override = JSON.stringify({ model: "gpt-4o", messages: MESSAGES, max_tokens: 9000 });

  it("refuses an OpenAI client with fetchOptions.body under hard_deny", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const client = new OpenAI({
      apiKey: "sk-test",
      fetch: transport,
      fetchOptions: { body: override } as never,
    });
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      chat(solwyn, { model: "gpt-4o", messages: MESSAGES, max_tokens: 100 }),
    );
    await solwyn.close();
    expect(error.reason).toBe("unsupported_override");
    expect(bodies).toHaveLength(0);
  });

  it("refuses an Anthropic client with fetchOptions.body under hard_deny", async () => {
    const bodies: unknown[] = [];
    const client = new Anthropic({
      apiKey: "sk-ant-test",
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(init?.body);
        return Response.json({});
      },
      fetchOptions: { body: override } as never,
    });
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      (solwyn as unknown as { messages: { create(b: Body): Promise<unknown> } }).messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        messages: MESSAGES,
      }),
    );
    await solwyn.close();
    expect(error.reason).toBe("unsupported_override");
    expect(bodies).toHaveLength(0);
  });

  it("leaves an alert-only client with fetchOptions.body unchanged", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const client = new OpenAI({
      apiKey: "sk-test",
      fetch: transport,
      fetchOptions: { body: override } as never,
    });
    const { fetch } = plane("alert_only");
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    await chat(solwyn, { model: "gpt-4o", messages: MESSAGES, max_tokens: 100 });
    await solwyn.close();
    expect(bodies[0]).toMatchObject({ max_tokens: 9000 });
  });
});

describe("Google: one model generation per hard_deny call", () => {
  function continuationFetch(streaming: boolean) {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const first = bodies.length === 1;
      const body = {
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: [{ text: first ? "synthetic start" : "synthetic end" }],
            },
            finishReason: first ? "CONTINUATION" : "STOP",
            ...(first ? { continuationToken: "c3ludGhldGlj" } : {}),
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100, totalTokenCount: 110 },
        modelVersion: "gemini-2.5-flash",
      };
      return streaming
        ? new Response(`data: ${JSON.stringify(body)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(body);
    });
    return bodies;
  }

  async function generate(solwyn: unknown, streaming: boolean, config: Body): Promise<unknown> {
    const { models } = solwyn as GoogleGenAI;
    const params = { model: "gemini-2.5-flash", contents: "synthetic", config };
    if (!streaming) return models.generateContent(params);
    const chunks: unknown[] = [];
    for await (const chunk of await models.generateContentStream(params)) chunks.push(chunk);
    return chunks.at(-1);
  }

  for (const streaming of [false, true]) {
    const label = streaming ? "streaming" : "buffered";

    it(`turns off default automatic continuation (${label})`, async () => {
      const bodies = continuationFetch(streaming);
      const { fetch, checks } = plane();
      const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
        apiKey: API_KEY,
        fetch,
        leaseEnabled: false,
      });
      await generate(solwyn, streaming, { maxOutputTokens: 100 });
      await solwyn.close();
      expect(checks[0]?.["estimated_output_bound"]).toBe(100);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.["generationConfig"]).toEqual({ maxOutputTokens: 100 });
    });

    it(`refuses explicit automatic continuation (${label})`, async () => {
      const bodies = continuationFetch(streaming);
      const { fetch } = plane();
      const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
        apiKey: API_KEY,
        fetch,
        leaseEnabled: false,
      });
      const error = await refusal(
        generate(solwyn, streaming, { maxOutputTokens: 100, automaticContinuation: true }),
      );
      await solwyn.close();
      expect(error.reason).toBe("multi_generation_loop");
      expect(bodies).toHaveLength(0);
    });

    it(`leaves continuation on for alert-only projects (${label})`, async () => {
      const bodies = continuationFetch(streaming);
      const { fetch } = plane("alert_only");
      const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
        apiKey: API_KEY,
        fetch,
        leaseEnabled: false,
      });
      await generate(solwyn, streaming, { maxOutputTokens: 100 });
      await solwyn.close();
      expect(bodies).toHaveLength(2);
    });
  }

  function afcFetch() {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const first = bodies.length === 1;
      return Response.json({
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: first
                ? [{ functionCall: { name: "synthetic_lookup", args: { id: "synthetic" } } }]
                : [{ text: "synthetic answer" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 80, totalTokenCount: 90 },
        modelVersion: "gemini-2.5-flash",
      });
    });
    return bodies;
  }

  function mcpTool(calls: unknown[]) {
    return mcpToTool({
      async listTools() {
        return {
          tools: [
            {
              name: "synthetic_lookup",
              description: "Synthetic fixture tool",
              inputSchema: { type: "object", properties: { id: { type: "string" } } },
            },
          ],
        };
      },
      async callTool(params: unknown) {
        calls.push(params);
        return { content: [{ type: "text", text: "synthetic result" }] };
      },
    } as never);
  }

  it("turns off default automatic function calling for an MCP tool", async () => {
    const bodies = afcFetch();
    const calls: unknown[] = [];
    const { fetch } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
    });
    await solwyn.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "synthetic",
      config: { maxOutputTokens: 100, tools: [mcpTool(calls)] },
    });
    await solwyn.close();
    expect(bodies).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ maximumRemoteCalls: 2 }],
    [{ disable: false, maximumRemoteCalls: 2 }],
    [{}],
  ])("refuses an enabled automatic function calling config %j", async (automaticFunctionCalling) => {
    const bodies = afcFetch();
    const calls: unknown[] = [];
    const { fetch } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
    });
    const error = await refusal(
      solwyn.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "synthetic",
        config: { maxOutputTokens: 100, tools: [mcpTool(calls)], automaticFunctionCalling },
      }),
    );
    await solwyn.close();
    expect(error.reason).toBe("multi_generation_loop");
    expect(bodies).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("accepts automatic function calling the caller disabled", async () => {
    const bodies = afcFetch();
    const calls: unknown[] = [];
    const { fetch } = plane();
    const solwyn = new Solwyn(new GoogleGenAI({ apiKey: "test-key" }), {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
    });
    await solwyn.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "synthetic",
      config: {
        maxOutputTokens: 100,
        tools: [mcpTool(calls)],
        automaticFunctionCalling: { disable: true },
      },
    });
    await solwyn.close();
    expect(bodies).toHaveLength(1);
  });
});

describe("Google: at most one successful generation request per hard_deny call", () => {
  const options = {
    surface: "models" as const,
    isStreaming: false,
    crossProvider: false,
    timeout: 600,
    maxRetries: 0,
  };

  function continuationFetch() {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const first = bodies.length === 1;
      return Response.json({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [{ text: "synthetic" }] },
            finishReason: first ? "CONTINUATION" : "STOP",
            ...(first ? { continuationToken: "c3ludGhldGlj" } : {}),
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100, totalTokenCount: 110 },
      });
    });
    return bodies;
  }

  // The adapter is driven directly with continuation left on, standing in for an SDK-internal
  // loop the request settings do not turn off.
  const kwargs = {
    model: "gemini-2.5-flash",
    contents: "synthetic",
    config: { maxOutputTokens: 100, automaticContinuation: true },
  };

  it("refuses a second request after a successful generation", async () => {
    const bodies = continuationFetch();
    const native = new GoogleGenAI({ apiKey: "test-key" });
    const dispatch = new GoogleAdapter().prepareCall(native, kwargs, {
      ...options,
      singleGeneration: {
        defaultFetch: (input: string, init?: unknown) =>
          globalThis.fetch(input, init as RequestInit),
      },
    });
    const error = await refusal(Promise.resolve().then(() => dispatch()));
    expect(error.reason).toBe("multi_generation_loop");
    expect(bodies).toHaveLength(1);
  });

  it("wraps the client's own fetch rather than the global one", async () => {
    const globalBodies = continuationFetch();
    const clientBodies: unknown[] = [];
    const native = new GoogleGenAI({
      apiKey: "test-key",
      httpOptions: {
        fetch: async (input: unknown, init?: RequestInit) => {
          clientBodies.push(init?.body);
          return globalThis.fetch(input as string, init);
        },
      } as never,
    });
    const dispatch = new GoogleAdapter().prepareCall(native, kwargs, {
      ...options,
      singleGeneration: {
        defaultFetch: (input: string, init?: unknown) =>
          globalThis.fetch(input, init as RequestInit),
      },
    });
    await refusal(Promise.resolve().then(() => dispatch()));
    expect(clientBodies).toHaveLength(1);
    expect(globalBodies).toHaveLength(1);
  });

  it("leaves the SDK loop alone without hard_deny admission", async () => {
    const bodies = continuationFetch();
    const native = new GoogleGenAI({ apiKey: "test-key" });
    await new GoogleAdapter().prepareCall(native, kwargs, options)();
    expect(bodies).toHaveLength(2);
  });
});

describe("Anthropic fallbacks and Qwen workspace hosts", () => {
  it("refuses Anthropic fallbacks, which send a second generation", async () => {
    const bodies: unknown[] = [];
    const client = new Anthropic({
      apiKey: "sk-ant-test",
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(init?.body);
        return Response.json({});
      },
    });
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      (solwyn as unknown as { messages: { create(b: Body): Promise<unknown> } }).messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        messages: MESSAGES,
        fallbacks: [{ model: "claude-opus-4-1", max_tokens: 9000 }],
      }),
    );
    await solwyn.close();
    expect(error.reason).toBe("multi_generation_loop");
    expect(bodies).toHaveLength(0);
  });

  it("detects a regional xAI host and refuses its reasoning model", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const client = new OpenAI({
      apiKey: "sk-test",
      baseURL: "https://eu-west-1.api.x.ai/v1",
      fetch: transport,
    });
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      chat(solwyn, { model: "grok-4", messages: MESSAGES, max_completion_tokens: 100 }),
    );
    await solwyn.close();
    expect(error).toMatchObject({ provider: "xai", reason: "reasoning_without_budget" });
    expect(bodies).toHaveLength(0);
  });

  it("detects a Model Studio workspace host as Qwen and enforces its reasoning rule", async () => {
    const { bodies, fetch: transport } = openaiTransport();
    const client = new OpenAI({
      apiKey: "sk-test",
      baseURL: "https://synthetic-workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      fetch: transport,
    });
    const { fetch } = plane();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch });
    const error = await refusal(
      chat(solwyn, { model: "qwen3.8-max", messages: MESSAGES, max_tokens: 100 }),
    );
    await solwyn.close();
    expect(error).toMatchObject({ provider: "qwen", reason: "reasoning_without_budget" });
    expect(bodies).toHaveLength(0);
  });
});

describe("model-id reasoning classification on hosts without their own rule", () => {
  function client(baseURL: string) {
    const transport = openaiTransport();
    return {
      client: new OpenAI({ apiKey: "sk-test", baseURL, fetch: transport.fetch }),
      ...transport,
    };
  }

  it.each([
    "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
    "https://coding.dashscope.aliyuncs.com/v1",
    "https://trial.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1",
  ])("detects %s as Qwen and refuses default thinking", async (baseURL) => {
    const { client: native, bodies } = client(baseURL);
    const { fetch } = plane();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    const error = await refusal(
      chat(solwyn, { model: "qwen3.8-max", messages: MESSAGES, max_tokens: 100 }),
    );
    await solwyn.close();
    expect(error).toMatchObject({ provider: "qwen", reason: "reasoning_without_budget" });
    expect(bodies).toHaveLength(0);
  });

  it("keeps a lookalike host generic", async () => {
    const { client: native, bodies } = client("https://dashscope.aliyuncs.com.example/v1");
    const { fetch } = plane();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    await chat(solwyn, { model: "gpt-4o", messages: MESSAGES, max_tokens: 100 });
    await solwyn.close();
    expect(bodies[0]).toMatchObject({ max_tokens: 100 });
  });

  it("applies the Qwen rule to a Qwen model on an unknown host", async () => {
    const { client: native, bodies } = client("https://llm.synthetic.example/v1");
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    const error = await refusal(
      chat(solwyn, { model: "Qwen/Qwen3-32B", messages: MESSAGES, max_tokens: 100 }),
    );
    expect(error).toMatchObject({
      provider: "openai_compatible",
      reason: "reasoning_without_budget",
    });
    expect(bodies).toHaveLength(0);
    await chat(solwyn, {
      model: "Qwen/Qwen3-32B",
      messages: MESSAGES,
      max_tokens: 100,
      enable_thinking: true,
      thinking_budget: 2000,
    });
    await solwyn.close();
    expect(checks[1]?.["estimated_output_bound"]).toBe(2100);
    expect(bodies[0]).toMatchObject({ max_tokens: 100, thinking_budget: 2000 });
  });

  it("trusts an explicit provider pin", async () => {
    const { client: native, bodies } = client("https://llm.synthetic.example/v1");
    const { fetch, checks } = plane();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch, provider: "openai_compatible" });
    await chat(solwyn, { model: "Qwen/Qwen3-32B", messages: MESSAGES, max_tokens: 100 });
    await solwyn.close();
    expect(checks[0]?.["estimated_output_bound"]).toBe(100);
    expect(bodies[0]).toMatchObject({ max_tokens: 100 });
  });

  it.each([
    ["https://llm.synthetic.example/v1", "grok-4"],
    ["https://openrouter.ai/api/v1", "x-ai/grok-4"],
  ])("applies the xAI rule to a Grok model on %s", async (baseURL, model) => {
    const { client: native, bodies } = client(baseURL);
    const { fetch } = plane();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    const error = await refusal(chat(solwyn, { model, messages: MESSAGES, max_tokens: 100 }));
    await solwyn.close();
    expect(error.reason).toBe("reasoning_without_budget");
    expect(bodies).toHaveLength(0);
  });

  it("leaves other models on an unknown host alone", async () => {
    const { client: native, bodies } = client("https://llm.synthetic.example/v1");
    const { fetch } = plane();
    const solwyn = new Solwyn(native, { apiKey: API_KEY, fetch });
    await chat(solwyn, { model: "meta-llama/Llama-3.3-70B", messages: MESSAGES });
    await chat(solwyn, { model: "x-ai/grok-4-fast-non-reasoning", messages: MESSAGES });
    await solwyn.close();
    expect(bodies.map((body) => body["max_tokens"])).toEqual([4096, 4096]);
  });
});
