import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, expect, it, vi } from "vitest";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { OpenAIAdapter } from "../../src/providers/openai";
import * as translation from "../../src/providers/translation/index";
import type { FetchLike } from "../../src/transport";

afterEach(() => vi.restoreAllMocks());

function controlPlane() {
  const confirms: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    if (url.endsWith("/budgets/check"))
      return Response.json({
        allowed: true,
        remaining_budget: 100,
        reservation_id: "reservation-stream-error",
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: null,
        project_id: `proj_${"0".repeat(24)}`,
        price_hints: null,
      });
    if (url.endsWith("/budgets/confirm")) confirms.push(body);
    if (url.endsWith("/metadata/ingest")) {
      events.push(...body);
      return Response.json(
        { ingested: body.length, rejected: [], duplicates: [] },
        { status: 202 },
      );
    }
    return new Response(null, { status: 204 });
  };
  return {
    confirms,
    events,
    options: {
      apiKey: `sk_proj_${"0".repeat(64)}`,
      fetch,
      logger: noopLogger,
      leaseEnabled: false,
      velocityMode: "off" as const,
      reportUntrackedSurfaces: false,
      budgetCheckCacheTtl: 0,
      circuitBreakerFailureThreshold: 3,
    },
  };
}

it.each([
  "anthropic",
  "openai",
] as const)("%s status-less SSE errors trip the provider breaker after three failed streams", async (provider) => {
  const control = controlPlane();
  const providerFetch = vi.fn<typeof fetch>(async () => {
    const body =
      provider === "anthropic"
        ? [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"synthetic overload"}}\n\n',
          ].join("")
        : [
            'data: {"id":"chat_synthetic","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":0}}\n\n',
            'data: {"error":{"type":"server_error","message":"synthetic failure","code":"server_error"}}\n\n',
          ].join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const { sdk, call } = (() => {
    if (provider === "anthropic") {
      const sdk = new Solwyn(
        new Anthropic({ apiKey: "offline", maxRetries: 0, fetch: providerFetch }),
        control.options,
      );
      return {
        sdk,
        call: () =>
          sdk.messages.create({
            model: "claude-sonnet-4-6",
            messages: [],
            max_tokens: 10,
            stream: true,
          }),
      };
    }
    const sdk = new Solwyn(
      new OpenAI({ apiKey: "offline", maxRetries: 0, fetch: providerFetch }),
      control.options,
    );
    return {
      sdk,
      call: () => sdk.chat.completions.create({ model: "gpt-4o", messages: [], stream: true }),
    };
  })();
  try {
    for (let index = 0; index < 3; index++) {
      const stream = await call();
      await expect(
        (async () => {
          for await (const _chunk of stream) {
            /* Observe the provider error after the first chunk. */
          }
        })(),
      ).rejects.toMatchObject({ status: undefined });
    }
    await expect(call()).rejects.toMatchObject({ name: "ProviderUnavailableError" });
    expect(providerFetch).toHaveBeenCalledTimes(3);
  } finally {
    await sdk.close();
  }
  expect(control.events).toHaveLength(3);
  expect(control.events.every((event) => event["possibly_succeeded"] === true)).toBe(true);
});

it("caller abort still settles when the stream usage extractor throws", async () => {
  vi.spyOn(OpenAIAdapter.prototype, "createStreamAccumulator").mockReturnValue({
    observe: () => {},
    finalize: () => {
      throw new Error("synthetic usage failure");
    },
    getServiceTier: () => null,
  });
  const control = controlPlane();
  const warn = vi.fn();
  const caller = new AbortController();
  const error = new DOMException("synthetic abort", "AbortError");
  const sdk = new Solwyn(
    {
      chat: {
        completions: {
          create: async (_params: Record<string, unknown>, _options?: unknown) =>
            (async function* () {
              yield {};
              caller.abort();
              throw error;
            })(),
        },
      },
    },
    { ...control.options, logger: { ...noopLogger, warn }, reporterFlushInterval: 0.001 },
  );
  try {
    const stream = await sdk.chat.completions.create(
      { model: "gpt-4o", messages: [{ role: "user", content: "12345678" }], stream: true },
      { signal: caller.signal },
    );
    await stream.next();
    await expect(stream.next()).rejects.toBe(error);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes("onError callback raised")),
    ).toBe(false);
    await vi.waitFor(() => expect(control.confirms).toHaveLength(1));
  } finally {
    await sdk.close();
  }
  expect(control.confirms).toMatchObject([
    { token_details: { input_tokens: 2, output_tokens: 0, is_estimated: true } },
  ]);
  expect(control.events).toMatchObject([{ status: "success" }]);
});

it("keeps the served provider breaker neutral after a mid-stream translation failure", async () => {
  const translate = translation.translateStreamChunk;
  const failure = new Error("synthetic translation failure");
  let chunks = 0;
  const translateSpy = vi.spyOn(translation, "translateStreamChunk").mockImplementation((args) => {
    if (++chunks === 2) throw failure;
    return translate(args);
  });
  const create = async (_params: Record<string, unknown>): Promise<AsyncIterable<unknown>> => {
    throw Object.assign(new Error("synthetic rate limit"), { status: 429 });
  };
  const anthropicCreate = vi.fn(async () =>
    (async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "message_delta", usage: { output_tokens: 2 } };
      yield { type: "message_stop" };
    })(),
  );
  const control = controlPlane();
  const sdk = new Solwyn(
    { chat: { completions: { create } } },
    {
      ...control.options,
      circuitBreakerFailureThreshold: 1,
      fallback: [[{ messages: { create: anthropicCreate } }, "claude-sonnet-4-20250514"]],
    },
  );
  const call = () =>
    sdk.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "synthetic" }],
      max_tokens: 10,
      stream: true,
    });
  const consume = async (stream: AsyncIterable<unknown>) => {
    for await (const _chunk of stream) {
      /* Drain the translated stream. */
    }
  };
  try {
    await expect(consume(await call())).rejects.toBe(failure);
    translateSpy.mockRestore();
    await consume(await call());
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  } finally {
    await sdk.close();
  }
  expect(control.confirms).toHaveLength(2);
  expect(control.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", status: "error", input_tokens: 11 }),
      expect.objectContaining({ provider: "anthropic", status: "success" }),
    ]),
  );
  expect(
    control.events.find(
      (event) => event["provider"] === "anthropic" && event["status"] === "error",
    )?.["possibly_succeeded"],
  ).toBeUndefined();
});
