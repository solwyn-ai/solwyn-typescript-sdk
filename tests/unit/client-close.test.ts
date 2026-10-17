import { afterEach, describe, expect, it, vi } from "vitest";
import { SolwynError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { MetadataReporter } from "../../src/reporter";
import type { FetchLike } from "../../src/transport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const confirms: Record<string, unknown>[] = [];
  const checks: unknown[] = [];
  const events: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init?.body as string);
    if (url.endsWith("/budgets/check")) {
      checks.push(body);
      return Response.json({
        allowed: true,
        remaining_budget: 100,
        reservation_id: "reservation-close",
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
      return Response.json({ ingested: body.length, rejected: [] }, { status: 202 });
    }
    return new Response(null, { status: 204 });
  };
  return {
    checks,
    confirms,
    events,
    options: {
      apiKey: `sk_proj_${"0".repeat(64)}`,
      fetch,
      logger: noopLogger,
      leaseEnabled: false,
      velocityMode: "off" as const,
      reportUntrackedSurfaces: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("client shutdown", () => {
  it("drains paid in-flight work before reporting and provider shutdown", async () => {
    const control = fixture();
    const started = deferred<void>();
    const response = deferred<{ usage: { prompt_tokens: number; completion_tokens: number } }>();
    const create = vi.fn(async (_params: Record<string, unknown>) => {
      started.resolve();
      return response.promise;
    });
    const close = vi.fn(() => {
      expect(control.confirms).toHaveLength(1);
    });
    const sdk = new Solwyn({ chat: { completions: { create } }, close }, control.options);
    const call = sdk.chat.completions.create({ model: "gpt-4o" });
    await started.promise;
    const closing = sdk.close();
    expect(sdk.close()).toBe(closing);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    response.resolve({ usage: { prompt_tokens: 13, completion_tokens: 5 } });
    await call;
    await closing;
    await sdk[Symbol.asyncDispose]();
    expect(close).toHaveBeenCalledOnce();
    expect(control.events).toMatchObject([
      { status: "success", input_tokens: 13, output_tokens: 5 },
    ]);
  });

  it("rejects new chat, Responses, media, and deferred-stream work as soon as close begins", async () => {
    const control = fixture();
    const create = vi.fn(async (_params: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const stream = vi.fn((_params: Record<string, unknown>) => ({ done: async () => {} }));
    const sdk = new Solwyn(
      {
        chat: { completions: { create } },
        responses: { create, parse: create, stream },
        embeddings: { create },
      },
      control.options,
    );
    const deferredStream = sdk.responses.stream({ model: "gpt-4o" });
    const closing = sdk.close();
    const expectClosed = async (operation: () => unknown) => {
      try {
        await operation();
        throw new Error("call unexpectedly admitted");
      } catch (error) {
        expect(error).toBeInstanceOf(SolwynError);
        expect(error).toMatchObject({ message: "client is closed" });
      }
    };
    await expectClosed(() => sdk.chat.completions.create({ model: "gpt-4o" }));
    await expectClosed(() => sdk.responses.create({ model: "gpt-4o" }));
    await expectClosed(() => sdk.responses.parse({ model: "gpt-4o" }));
    await expectClosed(() => sdk.embeddings.create({ model: "text-embedding-3-small", input: [] }));
    await expectClosed(() => sdk.responses.stream({ model: "gpt-4o" }));
    await expectClosed(() => deferredStream.done());
    await closing;
    expect(control.checks).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("settles an open stream's observed usage without waiting for its consumer", async () => {
    const control = fixture();
    const create = async (_params: Record<string, unknown>) =>
      (async function* () {
        yield { usage: { prompt_tokens: 13, completion_tokens: 5 } };
        await new Promise(() => {});
      })();
    const sdk = new Solwyn({ chat: { completions: { create } } }, control.options);
    const stream = await sdk.chat.completions.create({ model: "gpt-4o", stream: true });
    await stream.next();
    await sdk.close();
    expect(control.confirms).toMatchObject([
      { token_details: { input_tokens: 13, output_tokens: 5 } },
    ]);
    await stream.return(undefined);
    expect(control.confirms).toHaveLength(1);
  });

  it("throws the closed-client error on the next provider chunk after close", async () => {
    const control = fixture();
    const create = async (_params: Record<string, unknown>) =>
      (async function* () {
        yield { usage: { prompt_tokens: 13, completion_tokens: 5 } };
        yield { usage: { prompt_tokens: 13, completion_tokens: 10 } };
      })();
    const sdk = new Solwyn({ chat: { completions: { create } } }, control.options);
    const stream = await sdk.chat.completions.create({ model: "gpt-4o", stream: true });
    await stream.next();
    await sdk.close();
    await expect(stream.next()).rejects.toMatchObject({
      name: "SolwynError",
      message: "client is closed",
    });
    expect(control.confirms).toMatchObject([
      { token_details: { input_tokens: 13, output_tokens: 5 } },
    ]);
    expect(control.confirms).toHaveLength(1);
    expect(control.events).toHaveLength(1);
  });

  it("drains stream setup and settles the returned unread stream before provider close", async () => {
    const control = fixture();
    const started = deferred<void>();
    const ready = deferred<AsyncGenerator<unknown>>();
    const create = async (_params: Record<string, unknown>) => {
      started.resolve();
      return ready.promise;
    };
    const close = vi.fn(() => {
      expect(control.confirms).toHaveLength(1);
    });
    const sdk = new Solwyn({ chat: { completions: { create } }, close }, control.options);
    const call = sdk.chat.completions.create({ model: "gpt-4o", stream: true });
    await started.promise;
    const closing = sdk.close();
    ready.resolve(
      (async function* () {
        yield {};
      })(),
    );
    const stream = await call;
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(control.events).toHaveLength(1);
    await stream.return(undefined);
    expect(control.confirms).toHaveLength(1);
  });

  it("rejects Bedrock sends after closing without admission or dispatch", async () => {
    class ConverseCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    class BedrockRuntimeClient {
      readonly send = vi.fn(async (_command: ConverseCommand) => ({}));
    }
    const raw = new BedrockRuntimeClient();
    const control = fixture();
    const sdk = new Solwyn(raw, control.options);
    await sdk.close();
    await expect(
      sdk.send(new ConverseCommand({ modelId: "anthropic.claude-3-5-sonnet" })),
    ).rejects.toMatchObject({ name: "SolwynError", message: "client is closed" });
    expect(raw.send).not.toHaveBeenCalled();
    expect(control.checks).toHaveLength(0);
  });

  it("bounds the in-flight drain and shares the remaining deadline with the reporter", async () => {
    vi.useFakeTimers();
    const control = fixture();
    const started = deferred<void>();
    const response = deferred<{ usage: { prompt_tokens: number; completion_tokens: number } }>();
    const create = async (_params: Record<string, unknown>) => {
      started.resolve();
      return response.promise;
    };
    const close = vi.fn();
    const reporterClose = vi.spyOn(MetadataReporter.prototype, "close");
    const sdk = new Solwyn(
      { chat: { completions: { create } }, close },
      { ...control.options, reporterShutdownDeadline: 0.05 },
    );
    const call = sdk.chat.completions.create({ model: "gpt-4o" });
    await started.promise;
    const closing = sdk.close();
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(reporterClose.mock.calls[0]?.[0]).toBe(0);
    response.resolve({ usage: { prompt_tokens: 13, completion_tokens: 5 } });
    await call;
  });

  it("shares the reporting deadline with advisory shutdown on a blackholed network", async () => {
    vi.useFakeTimers();
    const control = fixture();
    const close = vi.fn();
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith("/budgets/confirm") || url.endsWith("/untracked-surfaces"))
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      return control.options.fetch(url, init);
    };
    const sdk = new Solwyn(
      {
        chat: {
          completions: {
            create: async (_params: Record<string, unknown>) => ({
              usage: { prompt_tokens: 13, completion_tokens: 5 },
            }),
          },
        },
        files: { list: async () => ({ data: [] }) },
        close,
      },
      { ...control.options, fetch, reportUntrackedSurfaces: true, reporterShutdownDeadline: 0.05 },
    );
    await sdk.chat.completions.create({ model: "gpt-4o" });
    await sdk.files.list();
    const closing = sdk.close();
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await vi.advanceTimersByTimeAsync(100);
      await closing;
    }
  });
});
