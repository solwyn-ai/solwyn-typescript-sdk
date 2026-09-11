import { Stream as NativeStream } from "openai/core/streaming";
import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { RunStoppedError, SolwynError } from "../../src/errors";
import { noopLogger } from "../../src/logging";
import { abortStream, type StreamWrapperOptions, wrapStream } from "../../src/stream";
import { createTokenDetails } from "../../src/token-details";

function fixture(options: Partial<StreamWrapperOptions> = {}) {
  const observed = vi.fn();
  const complete = vi.fn();
  const error = vi.fn();
  const release = vi.fn();
  const controller = new AbortController();
  const abort = vi.spyOn(controller, "abort");
  const returned = vi.fn();
  const pulled = vi.fn();
  const source = new NativeStream(async function* () {
    try {
      for (let i = 0; i < 4; i++) {
        pulled();
        yield i;
      }
    } finally {
      returned();
    }
  }, controller);
  const stream = wrapStream({
    stream: source,
    accumulator: {
      observe: observed,
      finalize: () => createTokenDetails({ input_tokens: observed.mock.calls.length }),
      getServiceTier: () => null,
    },
    onComplete: complete,
    onError: error,
    abortRelease: release,
    logger: noopLogger,
    ...options,
  });
  return { stream, source, observed, complete, error, release, abort, returned, pulled };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _item of iterable) count++;
  return count;
}

async function drainBytes(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let count = 0;
  while (!(await reader.read()).done) count++;
  return count;
}

describe("post-remediation consuming stream helpers", () => {
  it("keeps native NDJSON round-trip semantics through the actual SDK parser", async () => {
    const f = fixture();
    const parsed = NativeStream.fromReadableStream<number>(
      f.stream.toReadableStream(),
      new AbortController(),
    );
    let sum = 0;
    for await (const item of parsed) sum += item;
    expect(sum).toBe(6);
    expect(f.observed).toHaveBeenCalledTimes(4);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("lets either tee branch run ahead and observes each source item only once", async () => {
    const f = fixture();
    const [left, right] = f.stream.tee();
    expect(left.controller).toBe(f.source.controller);
    expect(right.controller).toBe(f.source.controller);
    expect(f.pulled).not.toHaveBeenCalled();
    expect((await right.next()).done).toBe(false);
    expect((await left.next()).done).toBe(false);
    expect(await drain(left)).toBe(3);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(await drain(right)).toBe(3);
    expect(f.observed).toHaveBeenCalledTimes(4);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("can cancel one unread branch while its sibling finishes", async () => {
    const f = fixture();
    const [left, right] = f.stream.tee();
    await left.return();
    expect(f.complete).not.toHaveBeenCalled();
    expect(await drain(right)).toBe(4);
    expect(await drain(left)).toBe(0);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])("settles both branch cancellations once (partial: %s)", async (partial) => {
    const f = fixture();
    const [left, right] = f.stream.tee();
    if (partial) await left.next();
    await Promise.all([left.return(), right.return()]);
    await Promise.all([left.return(), right.return(), f.stream.close()]);
    expect(f.observed).toHaveBeenCalledTimes(partial ? 1 : 0);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.pulled).toHaveBeenCalledTimes(partial ? 1 : 0);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("preserves one-item readable backpressure and partial cancellation", async () => {
    const f = fixture();
    const reader = f.stream.toReadableStream().getReader();
    await vi.waitFor(() => expect(f.pulled).toHaveBeenCalledTimes(1));
    expect(f.complete).not.toHaveBeenCalled();
    await reader.read();
    await reader.cancel();
    expect(f.pulled.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.returned).toHaveBeenCalledTimes(1);
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("retains stop precedence at a %s provider boundary", async (mode) => {
    const stop = new RunStoppedError({
      agentRunId: "run-streams",
      source: "server",
      reason: "run_stopped",
    });
    const f = fixture({ abortCheck: () => stop });
    f.abort.mockImplementation(() => {
      throw new TypeError();
    });
    if (mode === "readable") {
      await expect(drainBytes(f.stream.toReadableStream())).rejects.toBe(stop);
    } else {
      const [left, right] = f.stream.tee();
      await expect(left.next()).rejects.toBe(stop);
      await expect(right.next()).rejects.toBe(stop);
    }
    await f.stream.close();
    expect(f.pulled).toHaveBeenCalledTimes(1);
    expect(f.observed).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.error).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("keeps terminal provider errors and exactly one error callback through %s", async (mode) => {
    const failure = new RangeError();
    const f = fixture({
      stream: new NativeStream(async function* () {
        yield 0;
        throw failure;
      }, new AbortController()),
    });
    if (mode === "readable")
      await expect(drainBytes(f.stream.toReadableStream())).rejects.toBe(failure);
    else {
      const [left, right] = f.stream.tee();
      await expect(drain(left)).rejects.toBe(failure);
      await expect(drain(right)).rejects.toBe(failure);
    }
    await f.stream.close();
    expect(f.observed).toHaveBeenCalledTimes(1);
    expect(f.error).toHaveBeenCalledTimes(1);
    expect(f.error.mock.calls[0]?.[0]).toBe(failure);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("settles HALF_OPEN admission from the %s lifecycle", async (mode) => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 0,
      successThreshold: 1,
    });
    breaker.recordFailure();
    const admission = breaker.admit();
    expect(admission.ownsProbe).toBe(true);
    const f = fixture({
      onComplete: () => breaker.recordSuccess(admission),
      onError: () => breaker.releaseProbe(admission),
    });
    if (mode === "readable") await drainBytes(f.stream.toReadableStream());
    else {
      const [left, right] = f.stream.tee();
      await Promise.all([drain(left), drain(right)]);
    }
    expect(breaker.getState().state).toBe("closed");
    expect(breaker.admit().allowed).toBe(true);
  });

  it("releases an erroring HALF_OPEN helper admission for another probe", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 0 });
    breaker.recordFailure();
    const admission = breaker.admit();
    const f = fixture({
      stream: new NativeStream(
        () => ({
          next: async () => {
            throw new Error();
          },
        }),
        new AbortController(),
      ),
      onError: () => breaker.releaseProbe(admission),
    });
    await expect(drainBytes(f.stream.toReadableStream())).rejects.toBeInstanceOf(Error);
    expect(breaker.admit().ownsProbe).toBe(true);
  });

  it("rejects conversion after ordinary consumption, matching the native consumed-stream guard", async () => {
    const native = NativeStream.fromSSEResponse<number>(
      new Response("data: 0\n\ndata: 1\n\n"),
      new AbortController(),
    );
    const iterator = native[Symbol.asyncIterator]();
    await iterator.next();
    await expect(drainBytes(native.toReadableStream())).rejects.toBeInstanceOf(Error);
    await iterator.return?.();
    const f = fixture();
    await f.stream.next();
    expect(() => f.stream.toReadableStream()).toThrow(SolwynError);
    expect(() => f.stream.tee()).toThrow(SolwynError);
    expect(await drain(f.stream)).toBe(3);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("reserves a single consumer on %s conversion and rejects competing helpers/iteration", async (mode) => {
    const f = fixture();
    const converted = mode === "readable" ? f.stream.toReadableStream() : f.stream.tee();
    await expect(f.stream.next()).rejects.toBeInstanceOf(SolwynError);
    expect(() => f.stream.tee()).toThrow(SolwynError);
    expect(() => f.stream.toReadableStream()).toThrow(SolwynError);
    if (Array.isArray(converted)) {
      const [left, right] = converted;
      const bytes = left.toReadableStream();
      await expect(left.next()).rejects.toBeInstanceOf(SolwynError);
      expect(await drainBytes(bytes)).toBe(4);
      expect(await drain(right)).toBe(4);
    } else expect(await drainBytes(converted)).toBe(4);
    expect(f.observed).toHaveBeenCalledTimes(4);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("retries failed unread cancellation without re-settling or pulling", async () => {
    const f = fixture();
    f.abort.mockImplementationOnce(() => {
      throw new TypeError();
    });
    await expect(f.stream.close()).rejects.toBeInstanceOf(TypeError);
    await f.stream.close();
    await f.stream.close();
    expect(f.abort).toHaveBeenCalledTimes(2);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.pulled).not.toHaveBeenCalled();
  });

  it("cancels untransferred eager sources through the same native seam", async () => {
    const f = fixture();
    await abortStream(f.source);
    await abortStream(f.source);
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.pulled).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("yields a provider terminal error once per tee branch, then ends like the native SDK", async () => {
    const failure = new TypeError();
    const source = () =>
      new NativeStream(async function* () {
        yield 0;
        throw failure;
      }, new AbortController());
    const native = source().tee();
    for (const branch of native) {
      const iterator = branch[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      await expect(iterator.next()).rejects.toBe(failure);
      expect((await iterator.next()).done).toBe(true);
    }
    const f = fixture({ stream: source() });
    for (const branch of f.stream.tee()) {
      expect((await branch.next()).done).toBe(false);
      await expect(branch.next()).rejects.toBe(failure);
      expect((await branch.next()).done).toBe(true);
      expect((await branch.next()).done).toBe(true);
    }
    expect(f.error).toHaveBeenCalledTimes(1);
  });

  it("keeps an SDK-latched run stop authoritative on repeated tee reads", async () => {
    const stop = new RunStoppedError({
      agentRunId: "run-streams",
      source: "server",
      reason: "run_stopped",
    });
    const f = fixture({ abortCheck: () => stop });
    const [left, right] = f.stream.tee();
    for (const branch of [left, right]) {
      await expect(branch.next()).rejects.toBe(stop);
      await expect(branch.next()).rejects.toBe(stop);
    }
    expect(f.pulled).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.error).not.toHaveBeenCalled();
  });
});
