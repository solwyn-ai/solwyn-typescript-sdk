import { GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import type { SolwynOptions } from "../../src/client";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { run } from "../../src/node";
import { resetRunControlForTest } from "../../src/run-control";
import type { FetchLike } from "../../src/transport";

afterEach(() => {
  resetRunControlForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function controlPlane(extra: SolwynOptions = {}) {
  const confirms: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init?.body as string);
    if (url.endsWith("/budgets/check")) {
      return Response.json({
        allowed: true,
        remaining_budget: 100,
        reservation_id: "reservation-cancel",
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: null,
        project_id: `proj_${"0".repeat(24)}`,
        price_hints: null,
      });
    }
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
  const options: SolwynOptions = {
    apiKey: `sk_proj_${"0".repeat(64)}`,
    fetch,
    logger: noopLogger,
    leaseEnabled: false,
    velocityMode: "off",
    reportUntrackedSurfaces: false,
    circuitBreakerRecoveryTimeoutJitter: 0,
    budgetCheckCacheTtl: 0,
    ...extra,
  };
  return { options, confirms, events };
}

const usage = { prompt_tokens: 17, completion_tokens: 6 };
const aborted = () => new DOMException("cancelled", "AbortError");

describe("caller cancellation", () => {
  it.each([
    "chat",
    "responses",
    "media",
  ] as const)("already-aborted %s calls do not feed velocity or stop a run", async (surface) => {
    const create = vi.fn(async (_params: Record<string, unknown>, _options?: unknown) => ({
      usage,
    }));
    const control = controlPlane({ velocityMode: "deny", velocityRepeatCount: 3 });
    const sdk = new Solwyn(
      {
        chat: { completions: { create } },
        responses: { create },
        embeddings: { create },
      },
      control.options,
    );
    const call = (signal?: AbortSignal) => {
      if (surface === "media")
        return sdk.embeddings.create(
          { model: "text-embedding-3-small", input: "synthetic" },
          { signal },
        );
      if (surface === "responses")
        return sdk.responses.create({ model: "gpt-4o", input: "synthetic" }, { signal });
      return sdk.chat.completions.create({ model: "gpt-4o" }, { signal });
    };
    try {
      await run("preaborted-calls", async () => {
        const caller = new AbortController();
        caller.abort();
        for (let index = 0; index < 3; index++)
          await expect(call(caller.signal)).rejects.toBe(caller.signal.reason);
        await call();
      });
    } finally {
      await sdk.close();
    }
    expect(create).toHaveBeenCalledOnce();
    expect(control.events).toMatchObject([{ status: "success" }]);
    expect(control.events).toHaveLength(1);
  });

  it.each([
    "safe",
    "always",
  ] as const)("keeps OpenAI mid-stream caller termination and request errors neutral under %s", async (failoverIdempotency) => {
    class APIUserAbortError extends Error {}
    for (const phase of ["abort", "throw", "request-error"] as const) {
      let caller = new AbortController();
      let healthy = false;
      const error =
        phase === "request-error"
          ? Object.assign(new Error("invalid request"), { status: 400 })
          : new APIUserAbortError();
      const create = vi.fn(async (_params: Record<string, unknown>, _options?: unknown) => {
        if (healthy) return { usage };
        return (async function* () {
          yield { usage };
          if (phase === "abort") caller.abort();
          throw error;
        })();
      });
      const fallbackCreate = vi.fn(async () => ({ usage }));
      const control = controlPlane({
        failoverIdempotency,
        fallback: [
          [
            {
              baseURL: "https://api.deepseek.com/v1",
              chat: { completions: { create: fallbackCreate } },
            },
            "deepseek-chat",
          ],
        ],
      });
      const sdk = new Solwyn({ chat: { completions: { create } } }, control.options);
      try {
        for (let i = 0; i < 4; i += 1) {
          caller = new AbortController();
          const stream = (await sdk.chat.completions.create(
            { model: "gpt-4o", stream: true },
            { signal: caller.signal },
          )) as AsyncIterableIterator<unknown>;
          await stream.next();
          await expect(phase === "throw" ? stream.throw?.(error) : stream.next()).rejects.toBe(
            error,
          );
        }
        healthy = true;
        await sdk.chat.completions.create({ model: "gpt-4o" });
        expect(create).toHaveBeenCalledTimes(5);
        expect(fallbackCreate).not.toHaveBeenCalled();
      } finally {
        await sdk.close();
      }
      expect(control.confirms).toHaveLength(5);
      if (phase === "request-error") {
        const errors = control.events.filter((event) => event["status"] === "error");
        expect(errors).toHaveLength(4);
        for (const event of errors)
          expect(event).toMatchObject({
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            possibly_succeeded: true,
          });
      } else expect(control.events.every((event) => event["status"] === "success")).toBe(true);
    }
  });

  it.each([
    "safe",
    "always",
  ] as const)("keeps native Google reader cancellation neutral under %s", async (failoverIdempotency) => {
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const partial = {
        candidates: [],
        usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 6 },
      };
      const healthy = providerFetch.mock.calls.length > 4;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(partial)}\n\n`));
            if (healthy) controller.close();
            else
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", providerFetch);
    const fallback = {
      models: {
        generateContent: vi.fn(async () => ({})),
        generateContentStream: vi.fn(async function* () {
          yield {};
        }),
      },
    };
    const control = controlPlane({ failoverIdempotency, fallback: [[fallback, "gemini-2.5-pro"]] });
    const sdk = new Solwyn(new GoogleGenAI({ apiKey: "synthetic" }), control.options);
    try {
      for (let i = 0; i < 4; i += 1) {
        const caller = new AbortController();
        const stream = await sdk.models.generateContentStream({
          model: "gemini-2.5-flash",
          contents: "synthetic request",
          config: { abortSignal: caller.signal },
        });
        const iterator = stream[Symbol.asyncIterator]();
        await iterator.next();
        caller.abort();
        await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
      }
      const healthy = await sdk.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: "synthetic request",
      });
      for await (const _chunk of healthy) {
        /* Drain terminal usage. */
      }
      expect(providerFetch).toHaveBeenCalledTimes(5);
      expect(fallback.models.generateContentStream).not.toHaveBeenCalled();
    } finally {
      await sdk.close();
    }
    expect(control.confirms).toHaveLength(5);
    expect(
      control.confirms.every(
        (confirm) => (confirm["token_details"] as Record<string, unknown>)["input_tokens"] === 17,
      ),
    ).toBe(true);
    expect(control.events.every((event) => event["status"] === "success")).toBe(true);
  });

  it.each([
    "safe",
    "always",
  ] as const)("keeps Bedrock buffered, setup, and mid-stream cancellation neutral under %s", async (failoverIdempotency) => {
    class ConverseCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    class ConverseStreamCommand extends ConverseCommand {}
    for (const phase of ["buffered", "setup", "stream"] as const) {
      let caller = new AbortController();
      let cancel = true;
      const error = aborted();
      const send = vi.fn(async (_command: ConverseCommand, _options?: unknown) => {
        if (!cancel) return { usage: { inputTokens: 17, outputTokens: 6 } };
        if (phase === "stream")
          return {
            stream: (async function* () {
              yield { metadata: { usage: { inputTokens: 17, outputTokens: 6 } } };
              caller.abort();
              throw error;
            })(),
          };
        caller.abort();
        throw error;
      });
      const fallbackSend = vi.fn(async (_command: ConverseCommand) => ({
        usage: { inputTokens: 17, outputTokens: 6 },
      }));
      type Send = typeof send | typeof fallbackSend;
      class BedrockRuntimeClient {
        constructor(readonly send: Send) {}
      }
      const control = controlPlane({
        failoverIdempotency,
        fallback: [[new BedrockRuntimeClient(fallbackSend), "anthropic.claude-3-5-sonnet"]],
      });
      const sdk = new Solwyn(new BedrockRuntimeClient(send), control.options);
      try {
        for (let i = 0; i < 4; i += 1) {
          caller = new AbortController();
          const command =
            phase === "buffered"
              ? new ConverseCommand({ modelId: "anthropic.claude-3-5-sonnet" })
              : new ConverseStreamCommand({ modelId: "anthropic.claude-3-5-sonnet" });
          const call = sdk.send(command, { abortSignal: caller.signal });
          if (phase === "stream") {
            const response = (await call) as { stream: AsyncIterableIterator<unknown> };
            await response.stream.next();
            await expect(response.stream.next()).rejects.toBe(error);
          } else await expect(call).rejects.toBe(error);
        }
        cancel = false;
        await sdk.send(new ConverseCommand({ modelId: "anthropic.claude-3-5-sonnet" }));
        expect(send).toHaveBeenCalledTimes(5);
        expect(fallbackSend).not.toHaveBeenCalled();
      } finally {
        await sdk.close();
      }
      expect(control.confirms).toHaveLength(phase === "stream" ? 5 : 1);
    }
  });

  it.each([
    "safe",
    "always",
  ] as const)("keeps buffered and stream-setup aborts neutral under %s", async (failoverIdempotency) => {
    for (const stream of [false, true]) {
      let caller = new AbortController();
      let cancel = true;
      const error = aborted();
      const create = vi.fn(async (_params: Record<string, unknown>, _options?: unknown) => {
        if (cancel) {
          caller.abort();
          throw error;
        }
        return { usage };
      });
      const fallbackCreate = vi.fn(async () => ({ usage }));
      const control = controlPlane({
        failoverIdempotency,
        fallback: [
          [
            {
              baseURL: "https://api.deepseek.com/v1",
              chat: { completions: { create: fallbackCreate } },
            },
            "deepseek-chat",
          ],
        ],
      });
      const sdk = new Solwyn({ chat: { completions: { create } } }, control.options);
      try {
        for (let i = 0; i < 4; i += 1) {
          caller = new AbortController();
          await expect(
            sdk.chat.completions.create({ model: "gpt-4o", stream }, { signal: caller.signal }),
          ).rejects.toBe(error);
        }
        cancel = false;
        await expect(sdk.chat.completions.create({ model: "gpt-4o" })).resolves.toEqual({ usage });
        expect(create).toHaveBeenCalledTimes(5);
        expect(fallbackCreate).not.toHaveBeenCalled();
      } finally {
        await sdk.close();
      }
      expect(control.events.filter((event) => event["status"] === "error")).toHaveLength(4);
      expect(control.events.filter((event) => event["possibly_succeeded"] === true)).toHaveLength(
        4,
      );
    }
  });

  it.each([
    "safe",
    "always",
  ] as const)("settles observed usage once when a Google reader aborts under %s", async (failoverIdempotency) => {
    let caller = new AbortController();
    const generateContent = vi.fn(async (_params: Record<string, unknown>) => ({
      usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 6 },
    }));
    const generateContentStream = vi.fn(async function* (_params: Record<string, unknown>) {
      yield { usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 6 } };
      caller.abort();
      throw aborted();
    });
    const fallback = {
      models: {
        generateContent,
        generateContentStream: vi.fn(async function* () {
          yield {};
        }),
      },
    };
    const control = controlPlane({ failoverIdempotency, fallback: [[fallback, "gemini-2.5-pro"]] });
    const sdk = new Solwyn({ models: { generateContent, generateContentStream } }, control.options);
    try {
      for (let i = 0; i < 4; i += 1) {
        caller = new AbortController();
        const stream = await sdk.models.generateContentStream({
          model: "gemini-2.5-flash",
          config: { abortSignal: caller.signal },
        });
        const iterator = stream[Symbol.asyncIterator]();
        expect((await iterator.next()).done).toBe(false);
        await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
      }
      expect(fallback.models.generateContentStream).not.toHaveBeenCalled();
      await sdk.models.generateContent({ model: "gemini-2.5-flash" });
      expect(generateContent).toHaveBeenCalledOnce();
    } finally {
      await sdk.close();
    }
    expect(control.confirms).toHaveLength(5);
    expect(control.confirms.slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          token_details: expect.objectContaining({ input_tokens: 17, output_tokens: 6 }),
        }),
      ),
    );
    expect(control.events.every((event) => event["status"] === "success")).toBe(true);
  });

  it("admits another call after an established probe stream is abandoned", async () => {
    vi.useFakeTimers();
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const create = vi.fn(async (params: Record<string, unknown>) => {
      if (create.mock.calls.length === 1) throw Object.assign(new Error("busy"), { status: 429 });
      if (params["stream"])
        return (async function* () {
          yield { usage };
        })();
      return { usage };
    });
    const control = controlPlane({ circuitBreakerFailureThreshold: 1 });
    const sdk = new Solwyn({ chat: { completions: { create } } }, control.options);
    try {
      await expect(sdk.chat.completions.create({ model: "gpt-4o" })).rejects.toThrow("busy");
      time = 61_000;
      await sdk.chat.completions.create({ model: "gpt-4o", stream: true });
      await expect(sdk.chat.completions.create({ model: "gpt-4o" })).rejects.toMatchObject({
        name: "ProviderUnavailableError",
      });
      await vi.advanceTimersByTimeAsync(61_000);
      time = 122_000;
      await expect(sdk.chat.completions.create({ model: "gpt-4o" })).resolves.toEqual({ usage });
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      await sdk.close();
    }
  });

  it("an expired stream cannot consume a later recovery probe", async () => {
    vi.useFakeTimers();
    const failures = vi.spyOn(CircuitBreaker.prototype, "recordFailure");
    let broken = true;
    const create = async (_params: Record<string, unknown>) => {
      if (broken) throw Object.assign(new Error("busy"), { status: 429 });
      return (async function* () {
        yield { usage };
      })();
    };
    const control = controlPlane({
      circuitBreakerFailureThreshold: 1,
      circuitBreakerRecoveryTimeout: 1,
    });
    const sdk = new Solwyn({ chat: { completions: { create } } }, control.options);
    try {
      await expect(sdk.chat.completions.create({ model: "gpt-4o", stream: true })).rejects.toThrow(
        "busy",
      );
      const breaker = failures.mock.contexts[0];
      if (!(breaker instanceof CircuitBreaker)) throw new Error("provider breaker missing");
      broken = false;
      await vi.advanceTimersByTimeAsync(1000);
      const expired = (await sdk.chat.completions.create({
        model: "gpt-4o",
        stream: true,
      })) as AsyncIterableIterator<unknown>;
      await vi.advanceTimersByTimeAsync(1000);
      const current = (await sdk.chat.completions.create({
        model: "gpt-4o",
        stream: true,
      })) as AsyncIterableIterator<unknown>;
      await expired.return?.();
      expect(breaker.getState()).toMatchObject({ state: "half_open", successCount: 0 });
      expect(breaker.admit().allowed).toBe(false);
      for await (const _chunk of current) {
        /* Complete the current probe. */
      }
      expect(breaker.getState()).toMatchObject({ state: "half_open", successCount: 1 });
    } finally {
      await sdk.close();
    }
  });
});
