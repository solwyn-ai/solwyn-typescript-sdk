import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { RunStoppedError } from "../../src/errors";
import { noopLogger } from "../../src/logging";
import { createDeferredResponseStream, observeResponseStream } from "../../src/stream";
import { createTokenDetails } from "../../src/token-details";

function nativeFixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const raw = new OpenAI({
    apiKey: "offline",
    maxRetries: 0,
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const stop = new RunStoppedError({
    agentRunId: "run-review",
    source: "server",
    reason: "run_stopped",
  });
  let shouldStop = false;
  const complete = vi.fn();
  const error = vi.fn();
  const helper = createDeferredResponseStream({
    start: async () => {
      const source = raw.responses.stream({ model: "gpt-4o", input: [] });
      return observeResponseStream(
        source,
        {
          stream: source,
          accumulator: {
            observe() {},
            finalize: () => createTokenDetails(),
            getServiceTier: () => null,
          },
          onComplete: complete,
          onError: error,
          abortCheck: () => (shouldStop ? stop : undefined),
          logger: noopLogger,
        },
        error,
      );
    },
    onAbortBeforeStart() {},
    logger: noopLogger,
  });
  return {
    helper,
    stop,
    complete,
    error,
    finish(kind: "stop" | "abort" | "error") {
      if (kind === "stop") shouldStop = true;
      if (kind === "abort") helper.abort();
      if (kind === "error") {
        controller.error(new TypeError());
        return;
      }
      const event = {
        type: "response.created",
        sequence_number: 0,
        response: {
          id: "resp_review",
          object: "response",
          status: "in_progress",
          output: [],
          usage: null,
        },
      };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  };
}

async function settledFailure(operation: Promise<unknown>): Promise<unknown> {
  let result: { error: unknown } | undefined;
  operation.then(
    () => {
      result = { error: undefined };
    },
    (error: unknown) => {
      result = { error };
    },
  );
  await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 200 });
  return result?.error;
}

describe("review follow-up: terminal Responses waiters", () => {
  it.each([
    "done",
    "finalResponse",
    "iterate",
  ] as const)("rejects late waiters after stop consumed only by %s", async (mode) => {
    const f = nativeFixture();
    await f.helper.emitted("connect");
    const operation =
      mode === "iterate" ? f.helper[Symbol.asyncIterator]().next() : f.helper[mode]();
    const first = operation.then(
      () => undefined,
      (error: unknown) => error,
    );
    f.finish("stop");
    expect(await first).toBe(f.stop);
    expect(await settledFailure(f.helper.emitted("response.completed"))).toBe(f.stop);
    expect(await f.helper.emitted("error")).toBe(f.stop);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.error).not.toHaveBeenCalled();
  });

  it.each([
    "abort",
    "error",
  ] as const)("settles pending and late waiters on native %s", async (kind) => {
    const f = nativeFixture();
    await f.helper.emitted("connect");
    const pending = f.helper.emitted("response.completed");
    const observed = f.helper.done().then(
      () => undefined,
      (error: unknown) => error,
    );
    f.finish(kind);
    const failure = await observed;
    expect(failure).toBeInstanceOf(Error);
    expect(await settledFailure(pending)).toBe(failure);
    expect(await settledFailure(f.helper.emitted("response.completed"))).toBe(failure);
  });

  it("settles every stop waiter even when an earlier user error listener throws", async () => {
    const f = nativeFixture();
    await f.helper.emitted("connect");
    f.helper.on("error", () => {
      throw new Error();
    });
    const waiters = [f.helper.emitted("response.completed"), f.helper.emitted("end")];
    const observed = f.helper.done().catch(() => {});
    f.finish("stop");
    await observed;
    for (const waiter of waiters) expect(await settledFailure(waiter)).toBe(f.stop);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
});
