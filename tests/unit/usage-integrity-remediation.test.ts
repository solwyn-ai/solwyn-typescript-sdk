import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { BudgetExceededError, noopLogger, Solwyn } from "../../src/index";
import { run } from "../../src/node";
import { AnthropicAdapter } from "../../src/providers/anthropic";
import { BedrockAdapter } from "../../src/providers/bedrock";
import { GoogleAdapter } from "../../src/providers/google";
import { OpenAIAdapter } from "../../src/providers/openai";
import { buildCompatAdapters } from "../../src/providers/openai-compatible";
import { FakeControlPlane } from "../../src/testing";

function options(plane: FakeControlPlane) {
  return {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    logger: noopLogger,
    breakerReportingEnabled: false,
    reportUntrackedSurfaces: false,
  };
}

describe("F11 related usage integrity", () => {
  for (const stream of [false, true]) {
    it.each([
      ["negative", { prompt_tokens: -1, completion_tokens: -1 }],
      ["partial", { prompt_tokens: 1, completion_tokens: -1 }],
      ["missing output", { prompt_tokens: 1 }],
      ["missing usage", undefined],
      ["null counters", { prompt_tokens: null, completion_tokens: null }],
      ["fractional", { prompt_tokens: 0.5, completion_tokens: 0.5 }],
    ])(`retains paid authority for %s native OpenAI usage (stream=${stream})`, async (_name, usage) => {
      const plane = new FakeControlPlane({
        grantedTokens: 600,
        headroomShareTokens: 0,
        finalGrant: true,
      });
      plane.denyNext(1, { scope: "check" });
      let dispatched = 0;
      const result = { choices: [], ...(usage === undefined ? {} : { usage }) };
      const client = new Solwyn(
        new OpenAI({
          apiKey: crypto.randomUUID(),
          fetch: async () => {
            dispatched++;
            return stream
              ? new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, {
                  headers: { "content-type": "text/event-stream" },
                })
              : Response.json(result);
          },
        }),
        options(plane),
      );
      try {
        await run("unknown-native-usage", async () => {
          const paid = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [],
            max_tokens: 500,
            stream,
          });
          if (stream) {
            let chunks = 0;
            for await (const _chunk of paid as AsyncIterable<unknown>) chunks++;
            expect(chunks).toBe(1);
          } else expect(paid).toEqual(result);
          await expect(
            client.chat.completions.create({ model: "gpt-4o", messages: [], max_tokens: 500 }),
          ).rejects.toBeInstanceOf(BudgetExceededError);
        });
      } finally {
        await client.close();
      }
      expect(dispatched).toBe(1);
      expect(plane.checks).toHaveLength(1);
      expect(plane.confirms).toHaveLength(1);
      expect(plane.confirms[0]?.token_details?.is_estimated).toBe(true);
      expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(500);
    });

    it(`trusts native explicit zero usage (stream=${stream})`, async () => {
      const plane = new FakeControlPlane({
        grantedTokens: 600,
        headroomShareTokens: 0,
        finalGrant: true,
      });
      plane.denyNext(1, { scope: "check" });
      const result = { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } };
      const client = new Solwyn(
        new OpenAI({
          apiKey: crypto.randomUUID(),
          fetch: async () =>
            stream
              ? new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, {
                  headers: { "content-type": "text/event-stream" },
                })
              : Response.json(result),
        }),
        options(plane),
      );
      try {
        await run("zero-native-usage", async () => {
          for (let index = 0; index < 2; index++) {
            const paid = await client.chat.completions.create({
              model: "gpt-4o",
              messages: [],
              max_tokens: 500,
              stream,
            });
            if (stream)
              for await (const _chunk of paid as AsyncIterable<unknown>) {
              }
          }
        });
      } finally {
        await client.close();
      }
      expect(plane.checks).toHaveLength(0);
      expect(plane.confirms).toHaveLength(2);
      expect(plane.confirms.every((confirm) => confirm.token_details?.is_estimated === false)).toBe(
        true,
      );
      expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(0);
    });
  }

  const compat = buildCompatAdapters({ logger: noopLogger }).find(
    (adapter) => adapter.name === "groq",
  );
  if (!compat) throw new Error("Expected the reviewed Groq adapter");
  const providers = [
    {
      name: "openai",
      adapter: new OpenAIAdapter(),
      response: (input: unknown, output: unknown) => ({
        usage: { prompt_tokens: input, completion_tokens: output },
      }),
      events: (input: unknown, output: unknown) => [
        { usage: { prompt_tokens: input, completion_tokens: output } },
      ],
    },
    {
      name: "compat",
      adapter: compat,
      response: (input: unknown, output: unknown) => ({
        usage: { prompt_tokens: input, completion_tokens: output },
      }),
      events: (input: unknown, output: unknown) => [
        { usage: { prompt_tokens: input, completion_tokens: output } },
      ],
    },
    {
      name: "anthropic",
      adapter: new AnthropicAdapter({ logger: noopLogger }),
      response: (input: unknown, output: unknown) => ({
        usage: { input_tokens: input, output_tokens: output },
      }),
      events: (input: unknown, output: unknown) => [
        { type: "message_start", message: { usage: { input_tokens: input } } },
        { type: "message_delta", usage: { output_tokens: output } },
      ],
    },
    {
      name: "google",
      adapter: new GoogleAdapter(),
      response: (input: unknown, output: unknown) => ({
        usageMetadata: { promptTokenCount: input, candidatesTokenCount: output },
      }),
      events: (input: unknown, output: unknown) => [
        { usageMetadata: { promptTokenCount: input, candidatesTokenCount: output } },
      ],
    },
    {
      name: "bedrock",
      adapter: new BedrockAdapter({ logger: noopLogger }),
      response: (input: unknown, output: unknown) => ({
        usage: { inputTokens: input, outputTokens: output },
      }),
      events: (input: unknown, output: unknown) => [
        { metadata: { usage: { inputTokens: input, outputTokens: output } } },
      ],
    },
  ];
  for (const { name, adapter, response, events } of providers) {
    it.each([
      -1,
      NaN,
      Infinity,
      -Infinity,
      0.5,
      undefined,
      null,
    ])(`${name} flags invalid numeric input %s in buffered and streaming usage`, (input) => {
      expect(adapter.extractUsage(response(input, 1)).is_estimated).toBe(true);
      const accumulator = adapter.createStreamAccumulator({});
      for (const event of events(input, 1)) accumulator.observe(event);
      expect(accumulator.finalize().is_estimated).toBe(true);
    });
    it(`${name} preserves measured zero totals`, () => {
      expect(adapter.extractUsage(response(0, 0)).is_estimated).toBe(false);
      const accumulator = adapter.createStreamAccumulator({});
      for (const event of events(0, 0)) accumulator.observe(event);
      expect(accumulator.finalize().is_estimated).toBe(false);
    });
    it(`${name} marks unreadable optional usage as estimated`, () => {
      const optional = Object.defineProperty(
        {},
        name === "google"
          ? "cachedContentTokenCount"
          : name === "bedrock"
            ? "cacheReadInputTokens"
            : name === "anthropic"
              ? "cache_read_input_tokens"
              : "prompt_tokens_details",
        {
          get() {
            throw new Error();
          },
        },
      );
      const carrier = name === "google" ? "usageMetadata" : "usage";
      const raw = response(1, 1) as Record<string, unknown>;
      Object.defineProperties(raw[carrier], Object.getOwnPropertyDescriptors(optional));
      const details = adapter.extractUsage(raw);
      expect(details.input_tokens).toBe(1);
      expect(details.output_tokens).toBe(1);
      expect(details.is_estimated).toBe(true);
    });
  }

  it("preserves reported output when the OpenAI input field is absent", () => {
    const usage = new OpenAIAdapter().extractUsage({ usage: { completion_tokens: 5 } });
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(5);
    expect(usage.is_estimated).toBe(true);
  });

  it("retains uncertainty in malformed Google modality counters", () => {
    const details = new GoogleAdapter().extractUsage({
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        promptTokensDetails: [{ modality: "IMAGE", tokenCount: Number.NaN }],
      },
    });
    expect(details.input_tokens).toBe(1);
    expect(details.output_tokens).toBe(1);
    expect(details.is_estimated).toBe(true);
  });

  it("retains uncertainty in malformed Bedrock cache breakdown counters", () => {
    const details = new BedrockAdapter().extractUsage({
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteInputTokens: 2,
        cacheDetails: [{ ttl: "1h", inputTokens: Number.NaN }],
      },
    });
    expect(details.input_tokens).toBe(3);
    expect(details.output_tokens).toBe(1);
    expect(details.is_estimated).toBe(true);
  });
});

describe("native media usage integrity", () => {
  for (const surface of ["embedding", "image", "transcription"] as const) {
    it.each([
      false,
      true,
    ])(`${surface} preserves explicit zero versus malformed input usage (invalid=%s)`, async (invalid) => {
      const plane = new FakeControlPlane();
      const input = invalid ? -1 : 0;
      const result = {
        data: [],
        usage:
          surface === "embedding"
            ? { prompt_tokens: input, total_tokens: input }
            : {
                ...(surface === "transcription" ? { type: "tokens" } : {}),
                input_tokens: input,
                output_tokens: invalid ? 1 : 0,
              },
      };
      const client = new Solwyn(
        new OpenAI({ apiKey: crypto.randomUUID(), fetch: async () => Response.json(result) }),
        options(plane),
      );
      try {
        await run("native-media-usage", async () => {
          if (surface === "embedding")
            await client.embeddings.create({ model: "text-embedding-3-small", input: [] });
          else if (surface === "image")
            await client.images.generate({ model: "gpt-image-1", prompt: "", n: 1 });
          else
            await client.audio.transcriptions.create({
              model: "gpt-4o-transcribe",
              file: new File([], "empty.wav", { type: "audio/wav" }),
            });
        });
      } finally {
        await client.close();
      }
      expect(plane.leaseGrants).toHaveLength(0);
      expect(plane.confirms).toHaveLength(1);
      expect(plane.confirms[0]?.token_details?.is_estimated).toBe(invalid);
      expect(plane.confirms[0]?.token_details?.output_tokens).toBe(
        invalid && surface !== "embedding" ? 1 : 0,
      );
    });
  }
});

describe("related Bedrock command snapshot", () => {
  it.each([
    false,
    true,
  ])("dispatches the admitted native cap after budget wait (mutated=%s)", async (mutated) => {
    const plane = new FakeControlPlane();
    let release!: () => void;
    let reached!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let dispatchedCap: unknown;
    const checks = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    const native = new BedrockRuntimeClient({
      region: "us-east-1",
      credentials: { accessKeyId: crypto.randomUUID(), secretAccessKey: crypto.randomUUID() },
      requestHandler: {
        handle: async (request: { body?: unknown }) => {
          const body =
            request.body instanceof Uint8Array
              ? new TextDecoder().decode(request.body)
              : request.body;
          if (typeof body !== "string") throw new Error("Expected a serialized native request");
          const parsed = JSON.parse(body);
          dispatchedCap = parsed.inferenceConfig?.maxTokens;
          return {
            response: {
              statusCode: 200,
              headers: {},
              body: new TextEncoder().encode(
                JSON.stringify({ usage: { inputTokens: 1, outputTokens: 1 } }),
              ),
            },
          };
        },
      },
    });
    const client = new Solwyn(native, {
      ...options(plane),
      leaseEnabled: false,
      fetch: async (url, init) => {
        if (String(url).endsWith("/budgets/check")) {
          reached();
          await pending;
        }
        return plane.fetch(url, init);
      },
    });
    const command = new ConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      messages: [],
      inferenceConfig: { maxTokens: 128 },
    });
    let nativeCommand: unknown;
    const send = vi.spyOn(native, "send");
    native.middlewareStack.add(
      (next, context) => async (args) => {
        nativeCommand = context.commandName;
        return next(args);
      },
      { step: "initialize", name: "snapshotPositiveControl" },
    );
    try {
      const paid = client.send(command);
      await checked;
      if (mutated && command.input.inferenceConfig)
        command.input.inferenceConfig.maxTokens = 16_000;
      release();
      await paid;
      expect(checks.mock.calls[0]?.[0].estimatedOutputBound).toBe(128);
      expect(dispatchedCap).toBe(128);
      expect(nativeCommand).toBe("ConverseCommand");
      expect(send.mock.calls[0]?.[0] === command).toBe(!mutated);
    } finally {
      release();
      await client.close();
      checks.mockRestore();
      send.mockRestore();
    }
  });
});
