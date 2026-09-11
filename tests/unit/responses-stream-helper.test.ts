import { describe, expect, it, vi } from "vitest";
import { SolwynError } from "../../src/errors";
import type { Logger } from "../../src/logging";
import {
  createDeferredResponseStream,
  type ResponseStreamLike,
  type ResponseStreamListener,
} from "../../src/stream";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface ListenerRecord {
  readonly listener: ResponseStreamListener;
  readonly once: boolean;
}

class FakeResponseStream implements ResponseStreamLike<unknown, object> {
  readonly controller = new AbortController();
  readonly response = { id: "opaque-final-response" };
  readonly #events: unknown[];
  readonly #listeners = new Map<string, ListenerRecord[]>();
  abortCalls = 0;
  doneCalls = 0;
  finalResponseCalls = 0;

  constructor(events: unknown[] = [{ type: "opaque-event" }]) {
    this.#events = events;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    let index = 0;
    return {
      next: async () => {
        const value = this.#events[index];
        if (index >= this.#events.length) return { done: true, value: undefined };
        index += 1;
        return { done: false, value };
      },
      return: async () => {
        this.abort();
        return { done: true, value: undefined };
      },
    };
  }

  abort(): void {
    this.abortCalls += 1;
    this.controller.abort();
  }

  async done(): Promise<void> {
    this.doneCalls += 1;
  }

  async finalResponse(): Promise<object> {
    this.finalResponseCalls += 1;
    return this.response;
  }

  on(event: string, listener: ResponseStreamListener): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push({ listener, once: false });
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: ResponseStreamListener): this {
    const listeners = this.#listeners.get(event);
    const index = listeners?.findIndex((record) => record.listener === listener) ?? -1;
    if (listeners !== undefined && index >= 0) listeners.splice(index, 1);
    return this;
  }

  once(event: string, listener: ResponseStreamListener): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push({ listener, once: true });
    this.#listeners.set(event, listeners);
    return this;
  }

  emitted(event: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (event !== "error") this.once("error", reject);
      this.once(event, resolve);
    });
  }

  emit(event: string, ...args: unknown[]): void {
    const listeners = this.#listeners.get(event) ?? [];
    this.#listeners.set(
      event,
      listeners.filter((record) => !record.once),
    );
    for (const { listener } of listeners) listener(...args);
  }
}

/** Event-backed iterator matching openai-node's listener-owned iterator queue. */
class EventBackedResponseStream implements ResponseStreamLike<unknown, object> {
  readonly controller = new AbortController();
  readonly response = { id: "opaque-event-backed-final" };
  readonly doneObserved = deferred<void>();
  readonly #end = deferred<void>();
  readonly #listeners = new Map<string, ListenerRecord[]>();
  iteratorCreations = 0;

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    this.iteratorCreations += 1;
    const pushed: unknown[] = [];
    const readers: Array<Deferred<unknown | undefined>> = [];
    let ended = false;

    this.on("event", (event) => {
      const reader = readers.shift();
      if (reader === undefined) pushed.push(event);
      else reader.resolve(event);
    });
    this.on("end", () => {
      ended = true;
      for (const reader of readers.splice(0)) reader.resolve(undefined);
    });
    const rejectReaders = (error: unknown) => {
      ended = true;
      for (const reader of readers.splice(0)) reader.reject(error);
    };
    this.on("error", rejectReaders);
    this.on("abort", rejectReaders);

    return {
      next: async () => {
        if (pushed.length > 0) return { done: false, value: pushed.shift() };
        if (ended) return { done: true, value: undefined };
        const reader = deferred<unknown | undefined>();
        readers.push(reader);
        const value = await reader.promise;
        return value === undefined ? { done: true, value } : { done: false, value };
      },
      return: async (value?: unknown) => {
        this.abort();
        return { done: true, value };
      },
    };
  }

  abort(): void {
    this.controller.abort();
    this.emit("end");
  }

  async done(): Promise<void> {
    this.doneObserved.resolve(undefined);
    await this.#end.promise;
  }

  async finalResponse(): Promise<object> {
    await this.done();
    return this.response;
  }

  on(event: string, listener: ResponseStreamListener): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push({ listener, once: false });
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: ResponseStreamListener): this {
    const listeners = this.#listeners.get(event);
    const index = listeners?.findIndex((record) => record.listener === listener) ?? -1;
    if (listeners !== undefined && index >= 0) listeners.splice(index, 1);
    return this;
  }

  once(event: string, listener: ResponseStreamListener): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push({ listener, once: true });
    this.#listeners.set(event, listeners);
    return this;
  }

  emitted(event: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (event !== "error") this.once("error", reject);
      this.once(event, resolve);
    });
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === "end") this.#end.resolve(undefined);
    const listeners = this.#listeners.get(event) ?? [];
    this.#listeners.set(
      event,
      listeners.filter((record) => !record.once),
    );
    for (const { listener } of listeners) listener(...args);
  }
}

function captureLogger(): Logger & { warnings: Array<[string, ...unknown[]]> } {
  const warnings: Array<[string, ...unknown[]]> = [];
  return {
    warnings,
    debug() {},
    info() {},
    warn(message, ...args) {
      warnings.push([message, ...args]);
    },
    error() {},
  };
}

describe("deferred Responses stream helper", () => {
  it("is synchronous to create and activates exactly once from every activating entry point", async () => {
    const exercise = async (
      activate: (
        stream: ReturnType<typeof createDeferredResponseStream>,
        source: FakeResponseStream,
      ) => Promise<void> | void,
    ) => {
      const source = new FakeResponseStream();
      const start = vi.fn(async () => source);
      const stream = createDeferredResponseStream({ start, onAbortBeforeStart: vi.fn() });

      expect(start).not.toHaveBeenCalled();
      await activate(stream, source);
      expect(start).toHaveBeenCalledTimes(1);
    };

    await exercise(async (stream) => {
      await stream[Symbol.asyncIterator]().next();
    });
    await exercise(async (stream) => {
      await stream.finalResponse();
    });
    await exercise(async (stream) => {
      await stream.done();
    });
    await exercise((stream) => {
      stream.on("event", () => {});
    });
    await exercise((stream) => {
      stream.once("event", () => {});
    });
    await exercise(async (stream, source) => {
      const received = stream.emitted("event");
      await Promise.resolve();
      source.emit("event", "opaque");
      await received;
    });
  });

  it("shares one controlled start across concurrent first uses", async () => {
    const source = new FakeResponseStream(["opaque"]);
    const startGate = deferred<ResponseStreamLike<unknown, object>>();
    const start = vi.fn(() => startGate.promise);
    const stream = createDeferredResponseStream({ start, onAbortBeforeStart: vi.fn() });

    const next = stream[Symbol.asyncIterator]().next();
    const done = stream.done();
    const finalResponse = stream.finalResponse();

    expect(start).toHaveBeenCalledTimes(1);
    startGate.resolve(source);

    await expect(next).resolves.toEqual({ done: false, value: "opaque" });
    await expect(done).resolves.toBeUndefined();
    await expect(finalResponse).resolves.toBe(source.response);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("attaches an event-backed provider iterator before events and end can precede first next", async () => {
    const source = new EventBackedResponseStream();
    const startGate = deferred<ResponseStreamLike<unknown, object>>();
    const stream = createDeferredResponseStream({
      start: () => startGate.promise,
      onAbortBeforeStart: vi.fn(),
    });

    const iterator = stream[Symbol.asyncIterator]();
    const done = stream.done();
    startGate.resolve(source);
    await source.doneObserved.promise;
    source.emit("event", "opaque-before-next");
    source.emit("end");
    await done;

    expect(source.iteratorCreations).toBe(1);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "opaque-before-next",
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("queues listeners before start resolves and preserves duplicate, off, once, and reentrant order", async () => {
    const source = new FakeResponseStream();
    const startGate = deferred<ResponseStreamLike<unknown, object>>();
    const stream = createDeferredResponseStream({
      start: () => startGate.promise,
      onAbortBeforeStart: vi.fn(),
    });
    const calls: string[] = [];
    const duplicate = () => calls.push("duplicate");
    const removed = () => calls.push("removed");

    stream.on("event", duplicate).on("event", removed).on("event", duplicate);
    expect(stream.off("event", duplicate)).toBe(stream);
    expect(stream.off("event", removed)).toBe(stream);
    stream.once("event", () => {
      calls.push("once");
      source.emit("event", "reentrant");
    });
    stream.on("event", () => calls.push("last"));

    startGate.resolve(source);
    await stream.done();
    source.emit("event", "first");

    expect(calls).toEqual(["duplicate", "once", "duplicate", "last", "last"]);
  });

  it("removes every once record before an earlier callback can off a mixed duplicate", async () => {
    const source = new EventBackedResponseStream();
    const startGate = deferred<ResponseStreamLike<unknown, object>>();
    const stream = createDeferredResponseStream({
      start: () => startGate.promise,
      onAbortBeforeStart: vi.fn(),
    });
    const shared = vi.fn();

    stream.on("event", () => stream.off("event", shared));
    stream.once("event", shared);
    stream.on("event", shared);
    const done = stream.done();
    startGate.resolve(source);
    await source.doneObserved.promise;
    source.emit("event", "first");
    source.emit("event", "second");
    source.emit("end");
    await done;

    expect(shared).toHaveBeenCalledTimes(2);
  });

  it("does not activate when off is the first operation", () => {
    const start = vi.fn(async () => new FakeResponseStream());
    const stream = createDeferredResponseStream({ start, onAbortBeforeStart: vi.fn() });

    expect(stream.off("event", () => {})).toBe(stream);
    expect(start).not.toHaveBeenCalled();
  });

  it("caches done and final response calls and preserves the opaque final response identity", async () => {
    const source = new FakeResponseStream();
    const stream = createDeferredResponseStream({
      start: async () => source,
      onAbortBeforeStart: vi.fn(),
    });

    const [firstDone, secondDone, firstResponse, secondResponse] = await Promise.all([
      stream.done(),
      stream.done(),
      stream.finalResponse(),
      stream.finalResponse(),
    ]);

    expect(firstDone).toBeUndefined();
    expect(secondDone).toBeUndefined();
    expect(firstResponse).toBe(source.response);
    expect(secondResponse).toBe(source.response);
    expect(source.doneCalls).toBe(1);
    expect(source.finalResponseCalls).toBe(1);
  });

  it("fans one startup error out to current and future waiters without changing its identity", async () => {
    const startGate = deferred<ResponseStreamLike<unknown, object>>();
    const stream = createDeferredResponseStream({
      start: () => startGate.promise,
      onAbortBeforeStart: vi.fn(),
    });
    const startupError = new Error("private provider detail");
    const errorListener = vi.fn();
    stream.on("error", errorListener);

    const current = [
      stream.done(),
      stream.finalResponse(),
      stream[Symbol.asyncIterator]().next(),
      stream.emitted("event"),
    ];
    const emittedError = stream.emitted("error");
    startGate.reject(startupError);

    for (const promise of current) await expect(promise).rejects.toBe(startupError);
    await expect(emittedError).resolves.toBe(startupError);
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(errorListener).toHaveBeenCalledWith(startupError);

    await expect(stream.done()).rejects.toBe(startupError);
    await expect(stream.finalResponse()).rejects.toBe(startupError);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(startupError);
    await expect(stream.emitted("event")).rejects.toBe(startupError);
    await expect(stream.emitted("error")).resolves.toBe(startupError);
    expect(errorListener).toHaveBeenCalledTimes(1);
  });

  it("reports a malformed resolved provider surface as a typed startup invariant error", async () => {
    const malformed = {
      controller: { signal: {} },
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      finalResponse: async () => ({}),
      abort() {},
      done: async () => {},
      on() {},
      off() {},
      once() {},
      emitted: async () => undefined,
    } as unknown as ResponseStreamLike<unknown, object>;
    const errorListener = vi.fn();
    const stream = createDeferredResponseStream({
      start: async () => malformed,
      onAbortBeforeStart: vi.fn(),
    });
    stream.on("error", errorListener);

    let caught: unknown;
    try {
      await stream.done();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SolwynError);
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(errorListener).toHaveBeenCalledWith(caught);
  });

  it("pre-start abort is idempotent, releases once, and permanently prevents provider I/O", async () => {
    const start = vi.fn(async () => new FakeResponseStream());
    const release = vi.fn();
    const stream = createDeferredResponseStream({ start, onAbortBeforeStart: release });

    stream.abort();
    stream.abort();
    stream.controller.abort();

    expect(stream.controller.signal.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    await expect(stream.done()).rejects.toMatchObject({ name: "AbortError" });
    await expect(stream.finalResponse()).rejects.toMatchObject({ name: "AbortError" });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("delegates an in-flight or post-start abort to the provider exactly once", async () => {
    const inFlightSource = new FakeResponseStream();
    const startGate = deferred<ResponseStreamLike<unknown, object>>();
    const inFlight = createDeferredResponseStream({
      start: () => startGate.promise,
      onAbortBeforeStart: vi.fn(),
    });
    const pendingDone = inFlight.done();
    inFlight.abort();
    inFlight.abort();
    startGate.resolve(inFlightSource);
    await pendingDone;
    expect(inFlightSource.abortCalls).toBe(1);
    expect(inFlight.controller.signal.aborted).toBe(true);

    const postStartSource = new FakeResponseStream();
    const postStart = createDeferredResponseStream({
      start: async () => postStartSource,
      onAbortBeforeStart: vi.fn(),
    });
    await postStart.done();
    postStart.controller.abort();
    postStart.abort();
    expect(postStartSource.abortCalls).toBe(1);
    expect(postStart.controller.signal.aborted).toBe(true);
  });

  it("treats iterator return as the same once-only abort lifecycle", async () => {
    const source = new FakeResponseStream();
    const stream = createDeferredResponseStream({
      start: async () => source,
      onAbortBeforeStart: vi.fn(),
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    await expect(iterator.return?.("opaque-return")).resolves.toEqual({
      done: true,
      value: "opaque-return",
    });
    stream.abort();
    expect(source.abortCalls).toBe(1);
  });

  it("suppresses and structurally logs pre-start abort cleanup callback failures", async () => {
    const logger = captureLogger();
    const stream = createDeferredResponseStream({
      start: async () => new FakeResponseStream(),
      onAbortBeforeStart: () => {
        throw new TypeError("private callback detail");
      },
      logger,
    });

    stream.abort();
    await expect(stream.done()).rejects.toMatchObject({ name: "AbortError" });
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.[1]).toBe("TypeError");
    expect(logger.warnings[0]?.join(" ")).not.toContain("private callback detail");
  });
});
