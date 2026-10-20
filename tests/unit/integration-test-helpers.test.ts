import type OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeOpenAITransport } from "../helpers/fake-openai-transport";
import { installIntegrationEnv } from "../helpers/integration-env";
import { OfflineViolationError } from "../helpers/offline-guard";

let OpenAIClient: typeof OpenAI;
let env: ReturnType<typeof installIntegrationEnv>;

beforeAll(async () => {
  // Guard import-time tracing and cached transports before loading provider/framework code.
  env = installIntegrationEnv();
  OpenAIClient = (await import("openai")).default;
});

afterAll(() => env.restore());

function client(transport: ReturnType<typeof createFakeOpenAITransport>, maxRetries = 0): OpenAI {
  return new OpenAIClient({
    apiKey: "synthetic-unused",
    baseURL: "https://provider.invalid/v1",
    fetch: transport.fetch,
    maxRetries,
  });
}

describe("integration test environment", () => {
  it("disables tracing and credentials and restores exact env/fetch state idempotently", () => {
    const keys = [
      "LANGSMITH_TRACING",
      "LANGCHAIN_TRACING_V2",
      "LANGCHAIN_API_KEY",
      "LANGSMITH_API_KEY",
      "OPENAI_API_KEY",
    ];
    for (const key of keys) vi.stubEnv(key, "synthetic-value");
    vi.stubEnv("OPENAI_AGENTS_DISABLE_TRACING", undefined);
    const originalFetch = globalThis.fetch;
    const nested = installIntegrationEnv();
    try {
      for (const key of keys) expect(process.env[key]).toBeUndefined();
      expect(process.env["OPENAI_AGENTS_DISABLE_TRACING"]).toBe("1");
    } finally {
      nested.restore();
    }
    try {
      expect(globalThis.fetch).toBe(originalFetch);
      for (const key of keys) expect(process.env[key]).toBe("synthetic-value");
      expect(process.env["OPENAI_AGENTS_DISABLE_TRACING"]).toBeUndefined();
      nested.restore();
      expect(globalThis.fetch).toBe(originalFetch);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records and rejects unexpected fetches and reuses the socket tripwire", async () => {
    const guarded = installIntegrationEnv();
    try {
      await expect(
        fetch("https://tracing.invalid/ingest", { method: "POST" }),
      ).rejects.toBeInstanceOf(OfflineViolationError);
      expect(guarded.fetchAttempts).toEqual([
        { url: "https://tracing.invalid/ingest", method: "POST" },
      ]);
      const { connect } = await import("node:net");
      expect(() => connect({ host: "provider.invalid", port: 443 })).toThrow(OfflineViolationError);
      expect(guarded.socketAttempts()).toBe(1);
    } finally {
      guarded.restore();
    }
  });
});

describe("fake OpenAI transport with the real client", () => {
  it("serves Chat Completions JSON with usable usage", async () => {
    const transport = createFakeOpenAITransport();
    const result = await client(transport).chat.completions.create({
      model: "synthetic-model",
      messages: [{ role: "user", content: "Synthetic input." }],
    });
    expect(result.choices[0]?.message.content).toBe("Synthetic reply.");
    expect(result.usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      url: "https://provider.invalid/v1/chat/completions",
      method: "POST",
      body: { model: "synthetic-model" },
    });
    expect(env.fetchAttempts).toEqual([]);
  });

  it("serves Chat Completions SSE with terminal usage followed by DONE", async () => {
    const transport = createFakeOpenAITransport();
    const stream = await client(transport).chat.completions.create({
      model: "synthetic-model",
      messages: [{ role: "user", content: "Synthetic input." }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")).toBe(
      "Synthetic reply.",
    );
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { total_tokens: 18 } });
    const raw = await transport.fetch("https://provider.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    expect((await raw.text()).trimEnd()).toMatch(/data: \[DONE\]$/);
  });

  it("serves Responses JSON with output items and usage", async () => {
    const transport = createFakeOpenAITransport();
    const result = await client(transport).responses.create({
      model: "synthetic-model",
      input: "Synthetic input.",
    });
    expect(result.status).toBe("completed");
    expect(result.output_text).toBe("Synthetic reply.");
    expect(result.output[0]).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
    });
    expect(result.usage).toMatchObject({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
  });

  it("serves Responses SSE in lifecycle order with completed usage", async () => {
    const transport = createFakeOpenAITransport();
    const stream = await client(transport).responses.create({
      model: "synthetic-model",
      input: "Synthetic input.",
      stream: true,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events[0]).toMatchObject({
      type: "response.created",
      response: { status: "in_progress" },
    });
    expect(events.map((event) => event.type)).toContain("response.output_item.done");
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    });
    expect(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("Synthetic reply.");
  });

  it.each([
    400, 401, 429, 500, 503,
  ])("serves a configurable %i without real fetch", async (status) => {
    const transport = createFakeOpenAITransport({ status });
    await expect(
      client(transport).chat.completions.create({ model: "synthetic-model", messages: [] }),
    ).rejects.toMatchObject({ status });
    expect(transport.requests).toHaveLength(1);
    expect(env.fetchAttempts).toEqual([]);
  });

  it("can recover from a configured error sequence on the Responses route", async () => {
    const transport = createFakeOpenAITransport({ status: [500, 200] });
    const result = await client(transport, 1).responses.create({
      model: "synthetic-model",
      input: "Synthetic input.",
    });
    expect(result.status).toBe("completed");
    expect(transport.requests).toHaveLength(2);
    expect(env.fetchAttempts).toEqual([]);
  });
});
