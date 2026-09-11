/**
 * Exercises `StreamWrapper`, including its unified synchronous/asynchronous wrapper.
 * Fully offline; no fetch.
 */

import { describe, expect, it, vi } from "vitest";
import { SolwynError } from "../../src/errors";
import type { Logger } from "../../src/logging";
import type { StreamUsageAccumulator } from "../../src/providers/protocol";
import {
  abortStream,
  materializeStreamForFailover,
  StreamWrapper,
  type StreamWrapperOptions,
  wrapStream,
} from "../../src/stream";
import { createTokenDetails, type TokenDetails, zeroTokenDetails } from "../../src/token-details";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function* fromArray(items: readonly unknown[]): AsyncGenerator<unknown> {
  for (const item of items) {
    yield item;
  }
}

async function* throwingAfter(items: readonly unknown[], error: unknown): AsyncGenerator<unknown> {
  for (const item of items) {
    yield item;
  }
  throw error;
}

interface FakeAccumulator extends StreamUsageAccumulator {
  observed: unknown[];
  finalizeReturn: TokenDetails;
}

function fakeAccumulator(
  finalizeReturn: TokenDetails = zeroTokenDetails(),
  tier: string | null = null,
): FakeAccumulator {
  const observed: unknown[] = [];
  return {
    observed,
    finalizeReturn,
    observe(chunk: unknown): void {
      observed.push(chunk);
    },
    finalize(): TokenDetails {
      return finalizeReturn;
    },
    getServiceTier(): string | null {
      return tier;
    },
  };
}

function captureLogger(): Logger & { warnings: string[] } {
  // Suppressed on_complete/on_error callback exceptions are logged at warning level using
  // the class name only, so capture the warning channel.
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
  };
}

function baseOptions(overrides: Partial<StreamWrapperOptions> = {}): StreamWrapperOptions {
  return {
    stream: fromArray([]),
    accumulator: fakeAccumulator(),
    onComplete: () => {},
    onError: () => {},
    logger: captureLogger(),
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Passthrough + observation.
// ---------------------------------------------------------------------------

describe("StreamWrapper — passthrough + observation", () => {
  it("yields every chunk unchanged, in order, and the accumulator observes the same sequence", async () => {
    const chunks = [{ i: 1 }, { i: 2 }, { i: 3 }];
    const acc = fakeAccumulator();
    const wrapper = wrapStream(baseOptions({ stream: fromArray(chunks), accumulator: acc }));

    const yielded = await collect(wrapper);

    expect(yielded).toEqual(chunks);
    expect(yielded[0]).toBe(chunks[0]);
    expect(acc.observed).toEqual(chunks);
  });

  it("observes each chunk BEFORE it is yielded", async () => {
    const chunks = ["a", "b"];
    const acc = fakeAccumulator();
    const wrapper = wrapStream(baseOptions({ stream: fromArray(chunks), accumulator: acc }));

    const order: string[] = [];
    for await (const chunk of wrapper) {
      // By the time the caller sees chunk N, the accumulator has already observed it.
      order.push(`observed:${acc.observed.length}`);
      order.push(`yielded:${String(chunk)}`);
    }

    expect(order).toEqual(["observed:1", "yielded:a", "observed:2", "yielded:b"]);
  });
});

// ---------------------------------------------------------------------------
// on_complete settlement.
// ---------------------------------------------------------------------------

describe("StreamWrapper — onComplete settlement", () => {
  it("fires onComplete exactly once with finalize()'s exact return and a non-negative float elapsedMs", async () => {
    const details = createTokenDetails({ input_tokens: 5, output_tokens: 6 });
    const acc = fakeAccumulator(details);
    const onComplete = vi.fn();
    const wrapper = wrapStream(
      baseOptions({ stream: fromArray([{ i: 1 }]), accumulator: acc, onComplete }),
    );

    await collect(wrapper);

    expect(onComplete).toHaveBeenCalledTimes(1);
    const [received, elapsedMs] = onComplete.mock.calls[0] as [TokenDetails, number];
    expect(received).toBe(details);
    expect(typeof elapsedMs).toBe("number");
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("fires onComplete once even for an empty stream", async () => {
    const onComplete = vi.fn();
    const wrapper = wrapStream(baseOptions({ stream: fromArray([]), onComplete }));

    const yielded = await collect(wrapper);

    expect(yielded).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not fire onComplete mid-iteration — settlement runs only at stream end", async () => {
    const onComplete = vi.fn();
    const wrapper = wrapStream(baseOptions({ stream: fromArray([1, 2, 3]), onComplete }));

    for await (const _chunk of wrapper) {
      expect(onComplete).not.toHaveBeenCalled();
    }

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("suppresses an onComplete that throws during direct iteration; iteration still completes", async () => {
    const logger = captureLogger();
    const chunks = [{ i: 1 }, { i: 2 }];
    const onComplete = vi.fn(() => {
      throw new TypeError("boom");
    });
    const wrapper = wrapStream(baseOptions({ stream: fromArray(chunks), onComplete, logger }));

    const yielded = await collect(wrapper);

    expect(yielded).toEqual(chunks);
    expect(onComplete).toHaveBeenCalledTimes(1);
    // Logged at WARNING (not ERROR — a user callback throwing is not an SDK-level error),
    // by class name only — never the message.
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("TypeError");
    expect(logger.warnings[0]).not.toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// Error path.
// ---------------------------------------------------------------------------

describe("StreamWrapper — error path", () => {
  it("fires onError once with the original error and re-raises the SAME error; never onComplete", async () => {
    const boom = new Error("inner-explode");
    const onComplete = vi.fn();
    const onError = vi.fn();
    const wrapper = wrapStream(
      baseOptions({ stream: throwingAfter([{ i: 1 }], boom), onComplete, onError }),
    );

    let caught: unknown;
    try {
      await collect(wrapper);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(boom);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("suppresses an onError that throws; the original stream error still propagates", async () => {
    const boom = new Error("original-stream-error");
    const logger = captureLogger();
    const onError = vi.fn(() => {
      throw new RangeError("callback-explode");
    });
    const wrapper = wrapStream(baseOptions({ stream: throwingAfter([], boom), onError, logger }));

    let caught: unknown;
    try {
      await collect(wrapper);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("RangeError");
    expect(logger.warnings[0]).not.toContain("callback-explode");
  });

  it("routes an accumulator finalization failure through onError without calling onComplete", async () => {
    const sentinel = new Error("finalize failed");
    const acc = fakeAccumulator();
    acc.finalize = () => {
      throw sentinel;
    };
    const onComplete = vi.fn();
    const onError = vi.fn();
    const wrapper = wrapStream(
      baseOptions({ stream: fromArray([]), accumulator: acc, onComplete, onError }),
    );

    await expect(collect(wrapper)).rejects.toBe(sentinel);
    expect(onError.mock.calls).toEqual([[sentinel]]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("still closes the source and preserves the finalization error on explicit close", async () => {
    const sentinel = new Error("finalize failed during close");
    const accumulator = fakeAccumulator();
    accumulator.finalize = () => {
      throw sentinel;
    };
    const aclose = vi.fn();
    const onError = vi.fn();
    const source = { async *[Symbol.asyncIterator]() {}, aclose };
    const wrapper = wrapStream(
      baseOptions({
        stream: source,
        accumulator,
        onError,
      }),
    );

    await expect(wrapper.close()).rejects.toBe(sentinel);
    expect(onError.mock.calls).toEqual([[sentinel]]);
    expect(aclose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Once-only settlement across paths.
// ---------------------------------------------------------------------------

describe("StreamWrapper — once-only settlement", () => {
  it("close() after natural exhaustion does not re-fire onComplete", async () => {
    const onComplete = vi.fn();
    const wrapper = wrapStream(baseOptions({ stream: fromArray([1]), onComplete }));

    await collect(wrapper);
    await wrapper.close();
    await wrapper.close();

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("close() after an error does NOT call onComplete", async () => {
    const boom = new Error("x");
    const onComplete = vi.fn();
    const onError = vi.fn();
    const wrapper = wrapStream(
      baseOptions({ stream: throwingAfter([], boom), onComplete, onError }),
    );

    await expect(collect(wrapper)).rejects.toBe(boom);
    await wrapper.close();

    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("Symbol.asyncDispose settles exactly once (delegates to close)", async () => {
    const onComplete = vi.fn();
    const wrapper = new StreamWrapper(baseOptions({ stream: fromArray([1]), onComplete }));

    await wrapper[Symbol.asyncDispose]();
    await wrapper[Symbol.asyncDispose]();

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Early abandonment + close forwarding.
// ---------------------------------------------------------------------------

describe("StreamWrapper — close / early abandonment", () => {
  it("aborts without success/error settlement and prefers aclose over close", async () => {
    const aclose = vi.fn();
    const close = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const inner = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
      aclose,
      close,
    };
    const wrapper = wrapStream(baseOptions({ stream: inner, onComplete, onError }));

    await abortStream(wrapper);
    await wrapper.close();

    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(aclose).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("settles exactly once with partial data when the consumer breaks out of for-await (F14)", async () => {
    // Breaking a for-await injects the generator's return() at the yield. Without a
    // finally-based settle this skipped BOTH the catch and the post-loop settle, so no
    // metadata event ever fired for an early-abandoned stream.
    const acc = fakeAccumulator(createTokenDetails({ input_tokens: 3, output_tokens: 4 }));
    const onComplete = vi.fn();
    const onError = vi.fn();
    const abortRelease = vi.fn();
    const wrapper = wrapStream(
      baseOptions({
        stream: fromArray([{ i: 1 }, { i: 2 }, { i: 3 }]),
        accumulator: acc,
        onComplete,
        onError,
        abortRelease,
      }),
    );

    let seen = 0;
    for await (const _chunk of wrapper) {
      seen += 1;
      break; // abandon after the first chunk
    }

    expect(seen).toBe(1);
    // Settled once, as SUCCESS, with whatever the accumulator observed up to the break.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect((onComplete.mock.calls[0] as [TokenDetails, number])[0].input_tokens).toBe(3);
    expect(acc.observed).toHaveLength(1);

    // A later close()/await using never re-fires the callback (idempotent).
    await wrapper.close();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(abortRelease).toHaveBeenCalledTimes(1);
  });

  it("settles exactly once when the consumer's loop body throws (return() injection, F14)", async () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const wrapper = wrapStream(
      baseOptions({ stream: fromArray([{ i: 1 }, { i: 2 }]), onComplete, onError }),
    );

    const bodyError = new Error("consumer-body-threw");
    await expect(
      (async () => {
        for await (const _chunk of wrapper) {
          throw bodyError; // for-await calls return() (not throw()) → success settlement
        }
      })(),
    ).rejects.toBe(bodyError);

    // Abandonment settles via onComplete (success), never onError.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("close() settles with partial data after partial consumption", async () => {
    const acc = fakeAccumulator(createTokenDetails({ input_tokens: 2 }));
    const onComplete = vi.fn();
    const wrapper = wrapStream(
      baseOptions({
        stream: fromArray([{ i: 1 }, { i: 2 }, { i: 3 }]),
        accumulator: acc,
        onComplete,
      }),
    );

    // Manually pull two chunks, then abandon.
    const iterator = wrapper[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await wrapper.close();

    expect(acc.observed).toHaveLength(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect((onComplete.mock.calls[0] as [TokenDetails, number])[0].input_tokens).toBe(2);
  });

  it("close() forwards to the inner stream's aclose() (preferred over close())", async () => {
    const aclose = vi.fn();
    const close = vi.fn();
    const inner = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
      aclose,
      close,
    };
    const wrapper = wrapStream(baseOptions({ stream: inner }));

    await wrapper.close();

    expect(aclose).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("close() falls back to the inner stream's close() when no aclose()", async () => {
    const close = vi.fn();
    const inner = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
      close,
    };
    const wrapper = wrapStream(baseOptions({ stream: inner }));

    await wrapper.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("awaits an async inner close() before the wrapper close resolves", async () => {
    let resolveInnerClose: (() => void) | undefined;
    const innerClose = new Promise<void>((resolve) => {
      resolveInnerClose = resolve;
    });
    const close = vi.fn(() => innerClose);
    const inner = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
      close,
    };
    const wrapper = wrapStream(baseOptions({ stream: inner }));

    let wrapperCloseResolved = false;
    const wrapperClose = wrapper.close().then(() => {
      wrapperCloseResolved = true;
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    expect(wrapperCloseResolved).toBe(false);
    resolveInnerClose?.();
    await wrapperClose;
    expect(wrapperCloseResolved).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("close() is a safe no-op for cleanup when the inner stream has neither close nor aclose", async () => {
    const wrapper = wrapStream(baseOptions({ stream: fromArray([1]) }));
    await expect(wrapper.close()).resolves.toBeUndefined();
  });

  it("repeated successful close() forwards cleanup only once and settles only once", async () => {
    const close = vi.fn();
    const onComplete = vi.fn();
    const inner = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
      close,
    };
    const wrapper = wrapStream(baseOptions({ stream: inner, onComplete }));

    await wrapper.close();
    await wrapper.close();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Cooperative stop-at-raw-boundary protocol.
// ---------------------------------------------------------------------------

describe("StreamWrapper — cooperative abort", () => {
  it("pulls and discards the third raw item, settles prior usage as success, closes, and latches the stop", async () => {
    const chunks = [{ raw: 1 }, { raw: 2 }, { raw: 3 }, { raw: 4 }];
    let pulled = 0;
    const iteratorReturn = vi.fn(async function (this: unknown) {
      expect(this).toBe(iterator);
      return { done: true as const, value: undefined };
    });
    const iterator: AsyncIterator<unknown> = {
      next: async () => {
        const value = chunks[pulled];
        pulled += 1;
        return { done: false as const, value };
      },
      return: iteratorReturn,
    };
    const aclose = vi.fn();
    const source = { [Symbol.asyncIterator]: () => iterator, aclose };
    const partialDetails = createTokenDetails({ input_tokens: 7, output_tokens: 2 });
    const accumulator = fakeAccumulator(partialDetails);
    const onComplete = vi.fn();
    const onError = vi.fn();
    const stop = new Error("stop-now");
    const wrapper = wrapStream({
      ...baseOptions({ stream: source, accumulator, onComplete, onError }),
      abortCheck: () => (pulled === 3 ? stop : undefined),
    }) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).resolves.toEqual({ done: false, value: chunks[0] });
    await expect(wrapper.next()).resolves.toEqual({ done: false, value: chunks[1] });
    await expect(wrapper.next()).rejects.toBe(stop);
    await expect(wrapper.next()).rejects.toBe(stop);

    expect(pulled).toBe(3);
    expect(accumulator.observed).toEqual(chunks.slice(0, 2));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect((onComplete.mock.calls[0] as [TokenDetails, number])[0]).toBe(partialDetails);
    expect(onError).not.toHaveBeenCalled();
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
    expect(aclose).toHaveBeenCalledTimes(1);
  });

  it("aborts at the first boundary with zero observed usage and keeps the same error after the seam clears", async () => {
    const first = { raw: "discarded" };
    const accumulator = fakeAccumulator();
    const onComplete = vi.fn();
    const stop = new Error("first-boundary-stop");
    let stopped = true;
    const wrapper = wrapStream({
      ...baseOptions({ stream: fromArray([first]), accumulator, onComplete }),
      abortCheck: () => (stopped ? stop : undefined),
    }) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).rejects.toBe(stop);
    stopped = false;
    await expect(wrapper.next()).rejects.toBe(stop);

    expect(accumulator.observed).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    const settled = (onComplete.mock.calls[0] as [TokenDetails, number])[0];
    expect(settled.input_tokens).toBe(0);
    expect(settled.output_tokens).toBe(0);
    expect(settled.cached_input_tokens).toBe(0);
    expect(settled.reasoning_tokens).toBe(0);
    expect(settled.is_estimated).toBe(false);
  });

  it("does not translate the discarded raw item or release pending translated output after abort", async () => {
    const raw = [{ id: 1 }, { id: 2 }];
    let pulled = 0;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const value = raw[pulled];
            pulled += 1;
            return { done: false as const, value };
          },
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
    const translatedRaw: unknown[] = [];
    const translator = (item: unknown) => {
      translatedRaw.push(item);
      const id = (item as { id: number }).id;
      return [`${id}-a`, `${id}-b`];
    };
    const stop = new Error("translated-stop");
    const wrapper = wrapStream({
      ...baseOptions({ stream, chunkTranslator: translator }),
      abortCheck: () => (pulled === 2 ? stop : undefined),
    }) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).resolves.toEqual({ done: false, value: "1-a" });
    await expect(wrapper.next()).resolves.toEqual({ done: false, value: "1-b" });
    await expect(wrapper.next()).rejects.toBe(stop);
    await expect(wrapper.next()).rejects.toBe(stop);

    expect(translatedRaw).toEqual([raw[0]]);
  });

  const cleanupThrowables: Array<[string, () => unknown, string]> = [
    ["ordinary Error", () => new Error("private body"), "Error"],
    [
      "AbortError DOMException",
      () => new DOMException("private body", "AbortError"),
      "DOMException",
    ],
    ["string", () => "private body", "string"],
    ["null", () => null, "object"],
    [
      "hostile object",
      () =>
        new Proxy(Object.create(null) as object, {
          get(_target, property) {
            if (property === "constructor") throw new Error("constructor trap body");
            return undefined;
          },
        }),
      "object",
    ],
  ];

  it.each(
    cleanupThrowables,
  )("suppresses %s cleanup throws on abort and logs only a safe type label", async (_label, makeThrowable, expectedType) => {
    const thrown = makeThrowable();
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const stop = new Error("winning stop");
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: { raw: true } }),
        return: async () => ({ done: true as const, value: undefined }),
      }),
      aclose: async () => {
        throw thrown;
      },
    };
    const wrapper = wrapStream({
      ...baseOptions({ stream: source, logger }),
      abortCheck: () => stop,
    }) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).rejects.toBe(stop);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "provider close raised during run-stop abort; suppressing (%s)",
      expectedType,
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private body");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("constructor trap body");
  });

  it("does not trust or log a callable spoofed constructor name", async () => {
    const leakedName = "response-body-must-stay-private";
    const spoofedConstructor = () => {};
    Object.defineProperty(spoofedConstructor, "name", { value: leakedName });
    const thrown = { constructor: spoofedConstructor };
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const stop = new Error("winning stop");
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: 1 }),
        return: async () => ({ done: true as const, value: undefined }),
      }),
      close: async () => {
        throw thrown;
      },
    };
    const wrapper = wrapStream({
      ...baseOptions({ stream: source, logger }),
      abortCheck: () => stop,
    }) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).rejects.toBe(stop);

    expect(warn).toHaveBeenCalledWith(
      "provider close raised during run-stop abort; suppressing (%s)",
      "object",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(leakedName);
  });

  it("suppresses repeated cleanup failures after abort, warns once, retries to success, and keeps stop identity", async () => {
    const firstCleanupError = new Error("first cleanup failure");
    const secondCleanupError = new Error("second cleanup failure");
    const aclose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(firstCleanupError)
      .mockRejectedValueOnce(secondCleanupError)
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: 1 }),
        return: async () => ({ done: true as const, value: undefined }),
      }),
      aclose,
    };
    const stop = new Error("latched stop");
    const onComplete = vi.fn();
    const abortRelease = vi.fn();
    const wrapper = wrapStream({
      ...baseOptions({ stream: source, logger, onComplete }),
      abortCheck: () => stop,
      abortRelease,
    }) as StreamWrapper & AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).rejects.toBe(stop);
    await expect(wrapper.close()).resolves.toBeUndefined();
    await expect(wrapper.aclose()).resolves.toBeUndefined();
    await expect(wrapper.next()).rejects.toBe(stop);

    expect(aclose).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "provider close raised during run-stop abort; suppressing (%s)",
      "Error",
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(abortRelease).toHaveBeenCalledTimes(1);
  });

  it("keeps the latched stop authoritative when finalization and the logger fail", async () => {
    const finalizeError = new Error("finalize failed");
    const accumulator = fakeAccumulator();
    accumulator.finalize = () => {
      throw finalizeError;
    };
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error("logger failed");
      },
      error: () => {},
    };
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: 1 }),
        return: async () => ({ done: true as const, value: undefined }),
      }),
      close: async () => {
        throw new Error("close failed");
      },
    };
    const stop = new Error("winning stop");
    const onError = vi.fn();
    const wrapper = wrapStream({
      ...baseOptions({ stream: source, accumulator, logger, onError }),
      abortCheck: () => stop,
    }) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).rejects.toBe(stop);
    expect(onError.mock.calls).toEqual([[finalizeError]]);
  });

  it("treats a thrown abortCheck as an ordinary processing failure", async () => {
    const seamError = new Error("abort seam failed");
    const onComplete = vi.fn();
    const onError = vi.fn();
    const wrapper = wrapStream({
      ...baseOptions({ stream: fromArray([1]), onComplete, onError }),
      abortCheck: () => {
        throw seamError;
      },
    }) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).rejects.toBe(seamError);
    expect(onError.mock.calls).toEqual([[seamError]]);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("StreamWrapper — explicit iterator lifecycle", () => {
  it("returns the public Proxy from Symbol.asyncIterator and exposes a wrapper-owned aclose", async () => {
    const innerAclose = vi.fn();
    const source = { [Symbol.asyncIterator]: () => fromArray([]), aclose: innerAclose };
    const wrapper = wrapStream(baseOptions({ stream: source })) as StreamWrapper &
      AsyncIterableIterator<unknown> & { aclose(): Promise<void> };

    expect(wrapper[Symbol.asyncIterator]()).toBe(wrapper);
    await wrapper.aclose();
    await wrapper.close();

    expect(innerAclose).toHaveBeenCalledTimes(1);
  });

  it("direct return settles partial success and forwards iterator return with its receiver before source cleanup", async () => {
    const order: string[] = [];
    let iterator: AsyncIterator<unknown>;
    const iteratorReturn = vi.fn(async function (this: unknown) {
      expect(this).toBe(iterator);
      order.push("iterator.return");
      return { done: true as const, value: undefined };
    });
    iterator = {
      next: async () => ({ done: false as const, value: 1 }),
      return: iteratorReturn,
    };
    const source = {
      [Symbol.asyncIterator]: () => iterator,
      aclose: vi.fn(async () => {
        order.push("source.aclose");
      }),
    };
    const onComplete = vi.fn();
    const wrapper = wrapStream(
      baseOptions({ stream: source, onComplete, chunkTranslator: () => ["translated"] }),
    ) as AsyncIterableIterator<unknown>;

    await expect(wrapper.next()).resolves.toEqual({ done: false, value: "translated" });
    await wrapper.return?.();

    expect(order).toEqual(["iterator.return", "source.aclose"]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("wrapper-owned throw settles an injected iterator error instead of delegating past lifecycle", async () => {
    const providerCleanup = vi.fn();
    const provider = (async function* () {
      try {
        yield { raw: 1 };
        yield { raw: 2 };
      } finally {
        providerCleanup();
      }
    })();
    const injected = new Error("consumer-injected");
    const onComplete = vi.fn();
    const onError = vi.fn();
    const abortRelease = vi.fn();
    const wrapper = wrapStream({
      ...baseOptions({ stream: provider, onComplete, onError }),
      abortRelease,
    }) as AsyncIterableIterator<unknown> & StreamWrapper;

    await expect(wrapper.next()).resolves.toEqual({ done: false, value: { raw: 1 } });
    await expect(wrapper.throw?.(injected)).rejects.toBe(injected);
    await wrapper.close();

    expect(onError.mock.calls).toEqual([[injected]]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(providerCleanup).toHaveBeenCalledTimes(1);
    expect(abortRelease).toHaveBeenCalledTimes(1);
  });

  it("serializes an in-flight pull, return, and close without duplicate cleanup or settlement", async () => {
    let resolvePull: ((result: IteratorResult<unknown>) => void) | undefined;
    const pull = new Promise<IteratorResult<unknown>>((resolve) => {
      resolvePull = resolve;
    });
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator = { next: vi.fn(() => pull), return: iteratorReturn };
    const aclose = vi.fn();
    const source = { [Symbol.asyncIterator]: () => iterator, aclose };
    const onComplete = vi.fn();
    const wrapper = wrapStream(
      baseOptions({ stream: source, onComplete }),
    ) as AsyncIterableIterator<unknown> & StreamWrapper;

    const nextPromise = wrapper.next();
    const returnPromise = wrapper.return?.();
    const closePromise = wrapper.close();
    await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledTimes(1));
    expect(iteratorReturn).not.toHaveBeenCalled();
    expect(aclose).not.toHaveBeenCalled();

    resolvePull?.({ done: false, value: 1 });
    await expect(nextPromise).resolves.toEqual({ done: false, value: 1 });
    await returnPromise;
    await closePromise;

    expect(iteratorReturn).toHaveBeenCalledTimes(1);
    expect(aclose).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping next calls so the provider and accumulator are never entered concurrently", async () => {
    const pullResolvers: Array<(result: IteratorResult<unknown>) => void> = [];
    let activePulls = 0;
    let maxActivePulls = 0;
    const iterator = {
      next: vi.fn(
        () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            activePulls += 1;
            maxActivePulls = Math.max(maxActivePulls, activePulls);
            pullResolvers.push((result) => {
              activePulls -= 1;
              resolve(result);
            });
          }),
      ),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const accumulator = fakeAccumulator();
    const wrapper = wrapStream(
      baseOptions({ stream: { [Symbol.asyncIterator]: () => iterator }, accumulator }),
    ) as AsyncIterableIterator<unknown>;

    const first = wrapper.next();
    const second = wrapper.next();
    await vi.waitFor(() => expect(pullResolvers).toHaveLength(1));
    expect(iterator.next).toHaveBeenCalledTimes(1);
    pullResolvers[0]?.({ done: false, value: 1 });
    await expect(first).resolves.toEqual({ done: false, value: 1 });
    await vi.waitFor(() => expect(pullResolvers).toHaveLength(2));
    pullResolvers[1]?.({ done: false, value: 2 });
    await expect(second).resolves.toEqual({ done: false, value: 2 });

    expect(maxActivePulls).toBe(1);
    expect(accumulator.observed).toEqual([1, 2]);
  });

  it("attempts source cleanup after iterator return fails and preserves settlement failure precedence", async () => {
    const settlementError = new Error("settlement wins");
    const iteratorError = new Error("iterator cleanup failed");
    const accumulator = fakeAccumulator();
    accumulator.finalize = () => {
      throw settlementError;
    };
    const iterator = {
      next: async () => ({ done: false as const, value: 1 }),
      return: vi.fn(async () => {
        throw iteratorError;
      }),
    };
    const sourceClose = vi.fn(async () => {
      throw new Error("source cleanup failed");
    });
    const source = { [Symbol.asyncIterator]: () => iterator, close: sourceClose };
    const wrapper = wrapStream(
      baseOptions({
        stream: source,
        accumulator,
      }),
    ) as AsyncIterableIterator<unknown> & StreamWrapper;

    await wrapper.next();
    await expect(wrapper.close()).rejects.toBe(settlementError);

    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(sourceClose).toHaveBeenCalledTimes(1);
  });

  it("retries failed cleanup without repeating settlement or release", async () => {
    const cleanupError = new Error("cleanup failed");
    const aclose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined);
    const onComplete = vi.fn();
    const abortRelease = vi.fn();
    const source = { async *[Symbol.asyncIterator]() {}, aclose };
    const wrapper = wrapStream({
      ...baseOptions({ stream: source, onComplete }),
      abortRelease,
    });

    await expect(wrapper.close()).rejects.toBe(cleanupError);
    await expect(wrapper.close()).resolves.toBeUndefined();

    expect(aclose).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(abortRelease).toHaveBeenCalledTimes(1);
  });

  it("propagates ordinary cleanup failure outside a cooperative abort", async () => {
    const cleanupError = Object.freeze({ kind: "opaque-cleanup" });
    const source = {
      async *[Symbol.asyncIterator]() {},
      close: async () => {
        throw cleanupError;
      },
    };
    const wrapper = wrapStream(baseOptions({ stream: source }));

    await expect(wrapper.close()).rejects.toBe(cleanupError);
  });

  const releaseCases: Array<
    [
      string,
      (wrapper: StreamWrapper & AsyncIterableIterator<unknown>) => Promise<unknown>,
      Partial<StreamWrapperOptions>,
    ]
  > = [
    ["natural exhaustion", async (wrapper) => collect(wrapper), { stream: fromArray([]) }],
    [
      "ordinary error",
      async (wrapper) => collect(wrapper).catch(() => undefined),
      { stream: throwingAfter([], new Error("x")) },
    ],
    ["explicit return", async (wrapper) => wrapper.return?.(), { stream: fromArray([1]) }],
    ["explicit close", async (wrapper) => wrapper.close(), { stream: fromArray([1]) }],
    [
      "async disposal",
      async (wrapper) => wrapper[Symbol.asyncDispose](),
      { stream: fromArray([1]) },
    ],
    [
      "cooperative abort",
      async (wrapper) => wrapper.next().catch(() => undefined),
      { stream: fromArray([1]), abortCheck: () => new Error("stop") },
    ],
    ["non-success abort", async (wrapper) => abortStream(wrapper), { stream: fromArray([1]) }],
  ];

  it.each(releaseCases)("releases exactly once on %s", async (_label, act, overrides) => {
    const abortRelease = vi.fn();
    const wrapper = wrapStream({
      ...baseOptions(overrides),
      abortRelease,
    }) as StreamWrapper & AsyncIterableIterator<unknown>;

    await act(wrapper);
    await wrapper.close().catch(() => undefined);

    expect(abortRelease).toHaveBeenCalledTimes(1);
  });

  it("null and always-clear abort callbacks preserve translated legacy iteration", async () => {
    for (const abortCheck of [null, () => undefined]) {
      const raw = [{ n: 1 }, { n: 2 }];
      const accumulator = fakeAccumulator();
      const wrapper = wrapStream({
        ...baseOptions({
          stream: fromArray(raw),
          accumulator,
          chunkTranslator: (item) => [(item as { n: number }).n],
        }),
        abortCheck,
      });

      await expect(collect(wrapper)).resolves.toEqual([1, 2]);
      expect(accumulator.observed).toEqual(raw);
    }
  });

  it("routes accumulator and translator failures through onError unchanged", async () => {
    const failures = [new Error("observe failed"), new Error("translator failed")];
    for (const [index, failure] of failures.entries()) {
      const accumulator = fakeAccumulator();
      if (index === 0) {
        accumulator.observe = () => {
          throw failure;
        };
      }
      const onError = vi.fn();
      const wrapper = wrapStream(
        baseOptions({
          stream: fromArray([1]),
          accumulator,
          onError,
          chunkTranslator:
            index === 1
              ? () => {
                  throw failure;
                }
              : null,
        }),
      );

      await expect(collect(wrapper)).rejects.toBe(failure);
      expect(onError.mock.calls).toEqual([[failure]]);
    }
  });
});

// ---------------------------------------------------------------------------
// Attribute passthrough.
// ---------------------------------------------------------------------------

describe("StreamWrapper — attribute passthrough (Proxy)", () => {
  it("delegates unknown attribute access to the wrapped inner stream", async () => {
    const inner = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
      response: { status: 200 },
    };
    const wrapper = wrapStream(baseOptions({ stream: inner }));

    const passthrough = wrapper as unknown as { response: { status: number } };
    expect(passthrough.response.status).toBe(200);
  });

  it("the wrapper's own surface wins over inner attributes of the same name", async () => {
    const inner = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {},
      close: () => "INNER-CLOSE",
    };
    const wrapper = wrapStream(baseOptions({ stream: inner }));
    // wrapper.close is the wrapper's method (returns a Promise), not the inner's string.
    expect(wrapper.close()).toBeInstanceOf(Promise);
    await wrapper.close();
  });
});

// ---------------------------------------------------------------------------
// chunk_translator seam.
// ---------------------------------------------------------------------------

describe("StreamWrapper — chunkTranslator seam", () => {
  it("null translator is a strict passthrough (never transforms chunks)", async () => {
    const chunks = [{ raw: 1 }];
    const wrapper = wrapStream(baseOptions({ stream: fromArray(chunks), chunkTranslator: null }));
    const yielded = await collect(wrapper);
    expect(yielded[0]).toBe(chunks[0]);
  });

  it("observes the RAW served chunk while yielding the translator's output list", async () => {
    const raw = [{ raw: "A" }, { raw: "B" }];
    const acc = fakeAccumulator();
    // one raw chunk -> two caller chunks.
    const translator = (chunk: unknown): unknown[] => {
      const tag = (chunk as { raw: string }).raw;
      return [`${tag}-1`, `${tag}-2`];
    };
    const wrapper = wrapStream(
      baseOptions({ stream: fromArray(raw), accumulator: acc, chunkTranslator: translator }),
    );

    const yielded = await collect(wrapper);

    // Accumulator saw the raw served chunks.
    expect(acc.observed).toEqual(raw);
    // Caller received the translated fan-out.
    expect(yielded).toEqual(["A-1", "A-2", "B-1", "B-2"]);
  });

  it("a translator may emit an empty list (structural event → zero caller chunks) while still observed", async () => {
    const raw = [{ kind: "message_start" }, { kind: "text", value: "hi" }];
    const acc = fakeAccumulator();
    const translator = (chunk: unknown): unknown[] => {
      const c = chunk as { kind: string; value?: string };
      return c.kind === "message_start" ? [] : [c.value];
    };
    const wrapper = wrapStream(
      baseOptions({ stream: fromArray(raw), accumulator: acc, chunkTranslator: translator }),
    );

    const yielded = await collect(wrapper);

    expect(acc.observed).toEqual(raw);
    expect(yielded).toEqual(["hi"]);
  });
});

// ---------------------------------------------------------------------------
// Non-blocking settlement discipline.
// ---------------------------------------------------------------------------

describe("StreamWrapper — non-blocking settlement", () => {
  it("does not block stream teardown on un-awaited work started inside onComplete", async () => {
    let slowResolved = false;
    // Fire-and-forget: onComplete kicks off slow work but returns immediately.
    const onComplete = () => {
      void new Promise<void>((resolve) => {
        setTimeout(() => {
          slowResolved = true;
          resolve();
        }, 10_000);
      });
    };
    const wrapper = wrapStream(baseOptions({ stream: fromArray([1, 2]), onComplete }));

    await collect(wrapper);

    // Settlement completed without waiting on the 10s "confirm".
    expect(slowResolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failover materialization seam; unsupported inputs must fail loudly.
// ---------------------------------------------------------------------------

describe("materializeStreamForFailover", () => {
  it("throws a typed SolwynError when invoked (unimplemented until M4)", () => {
    expect(() => materializeStreamForFailover({})).toThrow(SolwynError);
  });
});
