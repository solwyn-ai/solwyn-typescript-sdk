import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { noopLogger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import { clearRunTermination, markTerminated, resetRunControlForTest } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing";

afterEach(() => {
  resetRunControlForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Handle = ReturnType<typeof createSolwynMiddleware>;
interface Params {
  prompt: unknown;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}
const model = { provider: "openai", modelId: "gpt-4o" };
const usage = { inputTokens: { total: 50 }, outputTokens: { total: 20 } };

function generate(handle: Handle, params: Params, doGenerate: () => Promise<unknown>) {
  const wrap = handle.middleware.wrapGenerate as unknown as (args: unknown) => Promise<unknown>;
  return wrap({ model, params, doGenerate });
}

function stream(
  handle: Handle,
  params: Params,
  doStream: () => Promise<{ stream: ReadableStream<unknown> }>,
) {
  const wrap = handle.middleware.wrapStream as unknown as (
    args: unknown,
  ) => Promise<{ stream: ReadableStream<unknown> }>;
  return wrap({ model, params, doStream });
}

function fixture(options: Parameters<typeof createSolwynMiddleware>[0] = {}) {
  const plane = new FakeControlPlane();
  const handle = createSolwynMiddleware({
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    logger: noopLogger,
    breakerReportingEnabled: false,
    ...options,
  });
  return { plane, handle };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AI SDK stream cancellation accounting", () => {
  it.each([
    "run-stop",
    "caller-abort",
  ])("settles observed usage when %s withholds an error part", async (kind) => {
    const { plane, handle } = fixture();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<unknown>;
    await run("error-at-stop", async () => {
      const runId = currentRun()?.agentRunId ?? "";
      const result = await stream(
        handle,
        { prompt: [], maxOutputTokens: 100, abortSignal: abort.signal },
        async () => ({
          stream: new ReadableStream({
            start(controller) {
              source = controller;
              controller.enqueue({ type: "text-delta", delta: "abcd" });
            },
          }),
        }),
      );
      const reader = result.stream.getReader();
      await reader.read();
      const next = reader.read();
      if (kind === "run-stop")
        markTerminated(runId, { reason: "synthetic-stop", source: "server" });
      else abort.abort();
      source.enqueue({ type: "error", error: new Error("synthetic failure") });
      await expect(next).rejects.toMatchObject({
        name: kind === "run-stop" ? "RunStoppedError" : "AbortError",
      });
    });
    await handle.close();
    expect(plane.confirms).toHaveLength(1);
    expect(plane.ingested).toMatchObject([{ status: "success", output_tokens: 1 }]);
    expect(plane.leaseSurrenders).toMatchObject([{ spent_tokens: 100 }]);
  });

  it.each([
    false,
    true,
  ])("settles finish usage pulled after a run stop (leases=%s)", async (leaseEnabled) => {
    const { plane, handle } = fixture({ leaseEnabled });
    const cancel = vi.fn();
    let source!: ReadableStreamDefaultController<unknown>;
    await run("finish-before-stop", async () => {
      const runId = currentRun()?.agentRunId ?? "";
      const result = await stream(handle, { prompt: [], maxOutputTokens: 100 }, async () => ({
        stream: new ReadableStream({
          start(controller) {
            source = controller;
            controller.enqueue({ type: "text-delta", delta: "synthetic" });
          },
          cancel,
        }),
      }));
      const reader = result.stream.getReader();
      await reader.read();
      markTerminated(runId, { reason: "synthetic-stop", source: "server" });
      clearRunTermination(runId);
      source.enqueue({ type: "finish", usage });
      await expect(reader.read()).rejects.toMatchObject({ name: "RunStoppedError" });
    });
    await handle.close();
    expect(plane.confirms).toMatchObject([
      { token_details: { input_tokens: 50, output_tokens: 20, is_estimated: false } },
    ]);
    expect(plane.ingested).toMatchObject([
      { status: "success", input_tokens: 50, output_tokens: 20 },
    ]);
    expect(cancel).toHaveBeenCalledOnce();
    if (leaseEnabled) {
      expect(plane.confirms[0]?.lease_id).toEqual(expect.any(String));
      expect(plane.ingested[0]?.lease_id).toBe(plane.confirms[0]?.lease_id);
      expect(plane.leaseSurrenders).toMatchObject([{ spent_tokens: 70 }]);
    }
  });

  it.each([false, true])("settles observed usage on caller abort (finish=%s)", async (finish) => {
    const { plane, handle } = fixture();
    const abort = new AbortController();
    const reason = new DOMException("synthetic cancellation", "AbortError");
    let source!: ReadableStreamDefaultController<unknown>;
    await run("caller-abort", async () => {
      const result = await stream(
        handle,
        { prompt: [], maxOutputTokens: 100, abortSignal: abort.signal },
        async () => ({
          stream: new ReadableStream({
            start(controller) {
              source = controller;
              controller.enqueue(
                finish ? { type: "finish", usage } : { type: "text-delta", delta: "abcd" },
              );
            },
          }),
        }),
      );
      const reader = result.stream.getReader();
      await reader.read();
      const next = reader.read();
      abort.abort(reason);
      source.error(reason);
      await expect(next).rejects.toBe(reason);
    });
    await handle.close();
    expect(plane.confirms).toHaveLength(1);
    expect(plane.ingested).toMatchObject([
      {
        status: "success",
        input_tokens: finish ? 50 : 0,
        output_tokens: finish ? 20 : 1,
        token_details: { is_estimated: !finish },
      },
    ]);
    expect(plane.leaseSurrenders).toMatchObject([{ spent_tokens: finish ? 70 : 100 }]);
  });

  it("observes the part pulled at caller cancellation before withholding it", async () => {
    const { plane, handle } = fixture({ leaseEnabled: false });
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<unknown>;
    const result = await stream(handle, { prompt: [], abortSignal: abort.signal }, async () => ({
      stream: new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
    }));
    const next = result.stream.getReader().read();
    abort.abort();
    source.enqueue({ type: "finish", usage });
    await expect(next).rejects.toBe(abort.signal.reason);
    await handle.close();
    expect(plane.confirms).toMatchObject([
      { token_details: { input_tokens: 50, output_tokens: 20, is_estimated: false } },
    ]);
  });
});

describe("AI SDK preflight cancellation", () => {
  it.each([
    false,
    true,
  ])("rejects already-aborted calls before budget I/O (streaming=%s)", async (streaming) => {
    const { plane, handle } = fixture({ leaseEnabled: false });
    const abort = new AbortController();
    abort.abort();
    let dispatched = false;
    const call = streaming
      ? stream(handle, { prompt: [], abortSignal: abort.signal }, async () => {
          dispatched = true;
          return { stream: new ReadableStream() };
        })
      : generate(handle, { prompt: [], abortSignal: abort.signal }, async () => {
          dispatched = true;
          return { content: [], usage };
        });
    try {
      await expect(call).rejects.toBe(abort.signal.reason);
      expect(dispatched).toBe(false);
      expect(plane.checks).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it("aborts budget transport and skips dispatch when cancelled during preflight", async () => {
    const entered = deferred<void>();
    const abort = new AbortController();
    const reason = new DOMException("synthetic cancellation", "AbortError");
    let transportSignal: AbortSignal | null | undefined;
    const { handle } = fixture({
      leaseEnabled: false,
      fetch: async (_url, init) => {
        transportSignal = init?.signal;
        entered.resolve();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    let dispatched = false;
    const call = generate(handle, { prompt: [], abortSignal: abort.signal }, async () => {
      dispatched = true;
      return { content: [], usage };
    });
    const outcome = expect(call).rejects.toBe(reason);
    await entered.promise;
    abort.abort(reason);
    await outcome;
    expect(transportSignal?.aborted).toBe(true);
    expect(dispatched).toBe(false);
    await handle.close();
  });
});

describe("AI SDK middleware shutdown", () => {
  it("allows abandoned streams to be collected while a reachable stream still settles", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--expose-gc", "--import", "tsx", "tests/probes/ai-sdk-stream-retention.mts"],
      { cwd: process.cwd(), timeout: 30_000 },
    );
    expect(JSON.parse(stdout)).toEqual({ collected: true, liveConfirmed: true });
  }, 35_000);

  it.each([
    false,
    true,
  ])("rejects new calls as soon as close begins (streaming=%s)", async (streaming) => {
    const { plane, handle } = fixture();
    let dispatched = false;
    const closing = handle.close();
    const invoke = () =>
      streaming
        ? stream(handle, { prompt: [] }, async () => {
            dispatched = true;
            return { stream: new ReadableStream() };
          })
        : generate(handle, { prompt: [] }, async () => {
            dispatched = true;
            return { content: [], usage };
          });
    await expect(invoke()).rejects.toMatchObject({
      name: "SolwynError",
      message: "client is closed",
    });
    await closing;
    await expect(invoke()).rejects.toMatchObject({
      name: "SolwynError",
      message: "client is closed",
    });
    expect(dispatched).toBe(false);
    expect(plane.checks).toHaveLength(0);
    expect(plane.leaseGrants).toHaveLength(0);
  });

  it("drains buffered work before reporting closes", async () => {
    const { plane, handle } = fixture({ leaseEnabled: false });
    const entered = deferred<void>();
    const response = deferred<unknown>();
    const call = generate(handle, { prompt: [] }, async () => {
      entered.resolve();
      return response.promise;
    });
    await entered.promise;
    const closing = handle.close();
    expect(handle.close()).toBe(closing);
    expect(handle[Symbol.asyncDispose]()).toBe(closing);
    response.resolve({ content: [], usage });
    await call;
    await closing;
    expect(plane.confirms).toHaveLength(1);
    expect(plane.ingested).toMatchObject([
      { status: "success", input_tokens: 50, output_tokens: 20 },
    ]);
  });

  it("drains stream setup and settles observed usage before reporting closes", async () => {
    const { plane, handle } = fixture({ leaseEnabled: false });
    const entered = deferred<void>();
    const response = deferred<{ stream: ReadableStream<unknown> }>();
    const call = stream(handle, { prompt: [] }, async () => {
      entered.resolve();
      return response.promise;
    });
    await entered.promise;
    const closing = handle.close();
    response.resolve({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "finish", usage });
        },
      }),
    });
    const result = await call;
    await closing;
    await result.stream.cancel().catch(() => {});
    expect(plane.confirms).toHaveLength(1);
    expect(plane.ingested).toMatchObject([
      { status: "success", input_tokens: 50, output_tokens: 20 },
    ]);
  });

  it("settles open streams once and withholds chunks after close", async () => {
    const { plane, handle } = fixture({ leaseEnabled: false });
    const cancel = vi.fn();
    let source!: ReadableStreamDefaultController<unknown>;
    const result = await stream(handle, { prompt: [] }, async () => ({
      stream: new ReadableStream({
        start(controller) {
          source = controller;
          controller.enqueue({ type: "finish", usage });
        },
        cancel,
      }),
    }));
    const reader = result.stream.getReader();
    await reader.read();
    await handle.close();
    expect(plane.confirms).toHaveLength(1);
    expect(plane.ingested).toMatchObject([
      { status: "success", input_tokens: 50, output_tokens: 20 },
    ]);
    const next = reader.read();
    source.enqueue({ type: "text-delta", delta: "synthetic" });
    await expect(next).rejects.toMatchObject({ name: "SolwynError", message: "client is closed" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(plane.confirms).toHaveLength(1);
  });

  it("retains the reservation floor when closing an unmeasured lease stream", async () => {
    const { plane, handle } = fixture();
    await run("close-estimated", async () => {
      const result = await stream(handle, { prompt: [], maxOutputTokens: 100 }, async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", delta: "abcd" });
          },
        }),
      }));
      const reader = result.stream.getReader();
      await reader.read();
      await handle.close();
      await reader.cancel();
    });
    expect(plane.confirms).toHaveLength(1);
    expect(plane.ingested).toMatchObject([
      { status: "success", output_tokens: 1, token_details: { is_estimated: true } },
    ]);
    expect(plane.leaseSurrenders).toMatchObject([{ spent_tokens: 100 }]);
  });

  it("bounds draining and shares the remaining deadline with the reporter", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const { handle } = fixture({
      leaseEnabled: false,
      reporterShutdownDeadline: 0.05,
      logger: { ...noopLogger, warn },
    });
    const reporterClose = vi.spyOn(MetadataReporter.prototype, "close");
    const entered = deferred<void>();
    const response = deferred<unknown>();
    const call = generate(handle, { prompt: [] }, async () => {
      entered.resolve();
      return response.promise;
    });
    await entered.promise;
    const closing = handle.close();
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    expect(reporterClose.mock.calls[0]?.[0]).toBe(0);
    expect(warn).toHaveBeenCalledWith("middleware.close_inflight_timeout: 1 calls still active");
    response.resolve({ content: [], usage });
    await call;
  });
});
