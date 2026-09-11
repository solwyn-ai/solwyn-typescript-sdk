/**
 * `StreamWrapper` — a thin async-iterable wrapper that passes every provider-streamed
 * chunk through to the caller UNCHANGED while silently feeding each chunk to a
 * {@link StreamUsageAccumulator}; when the stream ends (exhausted, errored, or
 * abandoned early — an iterator `return()` from a consumer `break`/`return`, or an
 * explicit `close()`/`await using`), it fires an `onComplete`/`onError` settlement
 * callback EXACTLY ONCE with the accumulated {@link TokenDetails} so the caller can
 * settle a budget reservation and report metadata.
 *
 * Ported from `solwyn/stream.py`. Per CLAUDE.md's "one async client — no sync/async
 * split", Python's `SyncStreamWrapper` + `AsyncStreamWrapper` collapse into ONE class
 * over an `AsyncIterable<unknown>`. Both callbacks are always awaited at settlement.
 *
 * ONCE-ONLY settlement uses a plain synchronous flag (`#settled`) checked-and-set
 * before any `await` — JS's single-threaded run-to-completion replaces Python's
 * `threading.Lock` (there is no preemptive-thread race to guard against). The outcome
 * (fire exactly once) is identical; only the mechanism differs.
 *
 * NON-BLOCKING settlement: settlement only runs at stream end, never between chunks,
 * so it never blocks chunk delivery. The `onComplete` callback the CALLER wires in is
 * additionally obligated to be non-blocking (fire-and-forget the confirm, never await
 * a blocking HTTP call inline) — that obligation is enforced where the callback is
 * constructed, not here.
 *
 * PRIVACY: raw chunks are fully OPAQUE here — never inspected, logged, or stringified.
 * Translated fan-out is retained only by an opaque cursor from the content-privileged
 * `src/providers/translation/` package. This module passes cursor results through but
 * never retains or branches on translated content. Callback exceptions are logged by
 * their CONSTRUCTOR NAME only — never their string representation, which a provider error
 * can embed streamed content into.
 */

import { SolwynError } from "./errors";
import type { Logger } from "./logging";
import { consoleLogger } from "./logging";
import type { StreamUsageAccumulator } from "./providers/protocol";
import { StreamConversion } from "./providers/translation/stream-conversions";
import {
  type ChunkTranslationCursor,
  type ChunkTranslator,
  createChunkTranslationCursor,
} from "./providers/translation/stream-cursor";
import type { TokenDetails } from "./token-details";

/** Fired once on successful settlement with final usage and elapsed wall-time (ms). */
export type OnComplete = (tokenDetails: TokenDetails, elapsedMs: number) => void | Promise<void>;

/** Fired once when the inner stream raises; receives the original error. */
export type OnError = (error: unknown) => void | Promise<void>;

/**
 * Cross-dialect chunk-translation seam. Maps ONE raw served chunk to zero-or-more
 * caller-dialect chunks. The accumulator always observes the RAW served chunk (usage
 * settles against what was actually served); the caller receives the translator's
 * output. Dialect-specific translation remains injected by the routing subsystem;
 * this module imports only the opaque buffering capability.
 */
export type { ChunkTranslator } from "./providers/translation/stream-cursor";

/** Provider-agnostic listener shape used by the deferred Responses helper. */
export type ResponseStreamListener = (...args: unknown[]) => void;

/**
 * Explicit subset of the openai-node Responses stream contract used by Solwyn.
 * This stays structural so core never imports an optional provider SDK.
 */
export interface ResponseStreamLike<TEvent = unknown, TResponse = unknown>
  extends AsyncIterable<TEvent> {
  readonly controller: AbortController;
  /** Native outcome, when exposed; requesting cancellation is not itself an abort outcome. */
  readonly aborted?: boolean;
  finalResponse(): Promise<TResponse>;
  abort(): void;
  done(): Promise<void>;
  on(event: string, listener: ResponseStreamListener): unknown;
  off(event: string, listener: ResponseStreamListener): unknown;
  once(event: string, listener: ResponseStreamListener): unknown;
  emitted(event: string): Promise<unknown>;
}

/** Construction seam for a lazily-started Responses stream. */
export interface DeferredResponseStreamOptions<TEvent = unknown, TResponse = unknown> {
  /** Runs the budget/start pipeline exactly once on first activating use. */
  start: () => Promise<ResponseStreamLike<TEvent, TResponse>>;
  /** Release-only cleanup when abort wins before activation. */
  onAbortBeforeStart: () => void | Promise<void>;
  /** Logger for class-name-only callback/invariant notices. */
  logger?: Logger;
}

/** Explicit wrapper surface returned by {@link createDeferredResponseStream}. */
export interface DeferredResponseStream<TEvent = unknown, TResponse = unknown>
  extends AsyncIterable<TEvent> {
  readonly controller: AbortController;
  readonly ended: boolean;
  readonly errored: boolean;
  readonly aborted: boolean;
  finalResponse(): Promise<TResponse>;
  abort(): void;
  done(): Promise<void>;
  on(event: string, listener: ResponseStreamListener): this;
  off(event: string, listener: ResponseStreamListener): this;
  once(event: string, listener: ResponseStreamListener): this;
  emitted(event: string): Promise<unknown>;
}

type DeferredResponseState = "new" | "starting" | "started" | "failed" | "preaborted";

interface DeferredListenerRecord {
  readonly event: string;
  readonly original: ResponseStreamListener;
  readonly once: boolean;
  active: boolean;
}

interface DeferredTerminalFailure {
  readonly error: unknown;
  readonly kind: "abort" | "startup" | "provider";
}

type DeferredCallbackFailureContext =
  | "provider abort"
  | "pre-start abort cleanup"
  | "event listener";

function responseStreamAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isResponseStreamLike<TEvent, TResponse>(
  value: unknown,
): value is ResponseStreamLike<TEvent, TResponse> {
  if (!isObject(value)) return false;
  const controller = value["controller"];
  const signal = isObject(controller) ? controller["signal"] : undefined;
  return (
    isObject(controller) &&
    isObject(signal) &&
    typeof signal["addEventListener"] === "function" &&
    typeof signal["aborted"] === "boolean" &&
    typeof Reflect.get(value, Symbol.asyncIterator) === "function" &&
    typeof value["finalResponse"] === "function" &&
    typeof value["abort"] === "function" &&
    typeof value["done"] === "function" &&
    typeof value["on"] === "function" &&
    typeof value["off"] === "function" &&
    typeof value["once"] === "function" &&
    typeof value["emitted"] === "function"
  );
}

/**
 * Lazy, provider-agnostic bridge for openai-node's synchronous `responses.stream()`
 * surface. Construction is inert. The first iterator/promise/event subscription owns
 * activation; all uses then share the same provider stream and cached terminal calls.
 *
 * @internal Imported only by the client integration; it is not a package export.
 */
export function createDeferredResponseStream<TEvent = unknown, TResponse = unknown>(
  options: DeferredResponseStreamOptions<TEvent, TResponse>,
): DeferredResponseStream<TEvent, TResponse> {
  return new DeferredResponseStreamBridge(options);
}

class DeferredResponseStreamBridge<TEvent, TResponse>
  implements DeferredResponseStream<TEvent, TResponse>
{
  readonly controller = new AbortController();
  #start: (() => Promise<ResponseStreamLike<TEvent, TResponse>>) | undefined;
  #onAbortBeforeStart: (() => void | Promise<void>) | undefined;
  readonly #logger: Logger;
  readonly #listeners: DeferredListenerRecord[] = [];
  readonly #eventBridges = new Map<string, ResponseStreamListener>();
  readonly #eventWaiters = new Set<(failure: DeferredTerminalFailure) => void>();
  #state: DeferredResponseState = "new";
  #startPromise: Promise<ResponseStreamLike<TEvent, TResponse>> | undefined;
  #provider: ResponseStreamLike<TEvent, TResponse> | undefined;
  #terminalFailure: DeferredTerminalFailure | null = null;
  #ended = false;
  #aborted = false;
  #abortRequested = false;
  #providerAbortDelegated = false;
  #providerDonePromise: Promise<void> | undefined;
  #donePromise: Promise<void> | undefined;
  #finalResponsePromise: Promise<TResponse> | undefined;

  constructor(options: DeferredResponseStreamOptions<TEvent, TResponse>) {
    this.#start = options.start;
    this.#onAbortBeforeStart = options.onAbortBeforeStart;
    this.#logger = options.logger ?? consoleLogger;
    this.controller.signal.addEventListener("abort", () => this.#requestAbort(), { once: true });
  }

  get ended(): boolean {
    return this.#ended;
  }

  get errored(): boolean {
    return this.#terminalFailure !== null;
  }

  get aborted(): boolean {
    return this.#provider?.aborted ?? this.#aborted;
  }

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    let closed = false;
    const iteratorPromise = this.#ready().then((provider) =>
      closed ? undefined : provider[Symbol.asyncIterator](),
    );
    iteratorPromise.catch(() => {});

    return {
      next: async (): Promise<IteratorResult<TEvent>> => {
        if (closed) return { done: true, value: undefined };
        const iterator = await iteratorPromise;
        if (closed || iterator === undefined) return { done: true, value: undefined };
        try {
          return await iterator.next();
        } catch (error) {
          this.#recordTerminalFailure(error, "provider");
          throw error;
        }
      },
      return: async (value?: unknown): Promise<IteratorResult<TEvent>> => {
        closed = true;
        this.abort();
        return { done: true, value: value as TEvent };
      },
      throw: async (error?: unknown): Promise<IteratorResult<TEvent>> => {
        closed = true;
        this.abort();
        throw error;
      },
    };
  }

  finalResponse(): Promise<TResponse> {
    if (this.#finalResponsePromise === undefined) {
      const promise = this.#ready().then((provider) => provider.finalResponse());
      promise.catch((error) => this.#recordTerminalFailure(error, "provider"));
      this.#finalResponsePromise = promise;
    }
    return this.#finalResponsePromise;
  }

  abort(): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort();
      return;
    }
    this.#requestAbort();
  }

  done(): Promise<void> {
    if (this.#donePromise === undefined) {
      const promise = this.#ready().then(
        (provider) => this.#providerDonePromise ?? provider.done(),
      );
      promise.catch((error) => this.#recordTerminalFailure(error, "provider"));
      this.#donePromise = promise;
    }
    return this.#donePromise;
  }

  on(event: string, listener: ResponseStreamListener): this {
    this.#register(event, listener, false);
    this.#activate();
    return this;
  }

  off(event: string, listener: ResponseStreamListener): this {
    const record = this.#listeners.find(
      (candidate) =>
        candidate.active && candidate.event === event && candidate.original === listener,
    );
    if (record === undefined) return this;
    this.#removeListener(record);
    return this;
  }

  once(event: string, listener: ResponseStreamListener): this {
    this.#register(event, listener, true);
    this.#activate();
    return this;
  }

  emitted(event: string): Promise<unknown> {
    const failure = this.#terminalFailure;
    if (failure !== null) {
      if (event === "error" && failure.kind !== "abort") {
        return Promise.resolve(failure.error);
      }
      return Promise.reject(failure.error);
    }

    const promise = new Promise<unknown>((resolve, reject) => {
      let eventRecord: DeferredListenerRecord;
      let errorRecord: DeferredListenerRecord | undefined;
      const removePair = () => {
        this.#eventWaiters.delete(terminal);
        this.#removeListener(eventRecord);
        if (errorRecord !== undefined) this.#removeListener(errorRecord);
      };
      const terminal = (failure: DeferredTerminalFailure) => {
        removePair();
        if (event === "error" && failure.kind !== "abort") resolve(failure.error);
        else reject(failure.error);
      };
      if (event !== "error")
        errorRecord = this.#register(
          "error",
          (error) => {
            removePair();
            reject(error);
          },
          true,
        );
      eventRecord = this.#register(
        event,
        (value) => {
          removePair();
          resolve(value);
        },
        true,
      );
      this.#eventWaiters.add(terminal);
      this.#activate();
    });
    promise.catch(() => {});
    return promise;
  }

  #register(
    event: string,
    original: ResponseStreamListener,
    once: boolean,
  ): DeferredListenerRecord {
    const record: DeferredListenerRecord = {
      event,
      original,
      once,
      active: true,
    };
    this.#listeners.push(record);
    if (this.#provider !== undefined) this.#attachEvent(event, this.#provider);
    return record;
  }

  #removeListener(record: DeferredListenerRecord): void {
    record.active = false;
    const index = this.#listeners.indexOf(record);
    if (index !== -1) this.#listeners.splice(index, 1);
    if (this.#listeners.some((listener) => listener.active && listener.event === record.event))
      return;
    // Terminal observation is lifecycle-owned even after the last user listener is removed.
    if (record.event === "error" || record.event === "abort" || record.event === "end") return;
    const bridge = this.#eventBridges.get(record.event);
    if (bridge === undefined) return;
    this.#provider?.off(record.event, bridge);
    this.#eventBridges.delete(record.event);
  }

  #activate(): void {
    if (this.#state !== "new") return;
    this.#state = "starting";

    let started: Promise<ResponseStreamLike<TEvent, TResponse>>;
    try {
      const start = this.#start;
      this.#start = undefined;
      if (start === undefined) throw new SolwynError("Responses stream start was already released");
      started = Promise.resolve(start());
    } catch (error) {
      this.#recordStartupFailure(error);
      started = Promise.reject(error);
    }

    const startPromise = started
      .then((provider) => this.#connect(provider))
      .catch((error) => {
        this.#recordStartupFailure(error);
        throw error;
      });
    startPromise.catch(() => {});
    this.#startPromise = startPromise;
  }

  #ready(): Promise<ResponseStreamLike<TEvent, TResponse>> {
    this.#activate();
    const promise = this.#startPromise;
    if (promise !== undefined) return promise;
    const failure = this.#terminalFailure;
    if (failure !== null) {
      const rejected = Promise.reject<ResponseStreamLike<TEvent, TResponse>>(failure.error);
      rejected.catch(() => {});
      return rejected;
    }
    const rejected = Promise.reject<ResponseStreamLike<TEvent, TResponse>>(
      new SolwynError("deferred Responses stream lifecycle lost its start promise"),
    );
    rejected.catch(() => {});
    return rejected;
  }

  #connect(value: unknown): ResponseStreamLike<TEvent, TResponse> {
    if (!isResponseStreamLike<TEvent, TResponse>(value)) {
      const error = new SolwynError(
        "deferred Responses stream resolved without the required provider surface",
      );
      this.#recordStartupFailure(error);
      throw error;
    }

    this.#provider = value;
    this.#onAbortBeforeStart = undefined;
    this.#state = "started";
    // Native terminal events precede done()'s promise callbacks. Track them before
    // delivering any user end/abort/error listener, including end-only subscribers.
    this.#attachEvent("error", value);
    this.#attachEvent("abort", value);
    this.#attachEvent("end", value);
    for (const record of this.#listeners) {
      if (record.active) this.#attachEvent(record.event, value);
    }

    const providerSignal = value.controller.signal;
    providerSignal.addEventListener("abort", () => this.#mirrorProviderAbort(), { once: true });
    if (this.#abortRequested) {
      this.#delegateProviderAbort();
    } else if (providerSignal.aborted) {
      this.#mirrorProviderAbort();
    }
    // Terminal state exists independently of event subscriptions. A temporary
    // connect waiter may have removed the only error bridge before a later stop.
    // Queue after already-registered activation consumers, so a native iterator
    // attaches its event listeners before observing completion can release a test/
    // provider gate and allow the first event through.
    this.#providerDonePromise =
      this.#startPromise === undefined ? value.done() : this.#startPromise.then(() => value.done());
    this.#providerDonePromise.then(
      () => {
        this.#ended = true;
      },
      (error) => this.#recordTerminalFailure(error, "provider"),
    );
    return value;
  }

  #attachEvent(event: string, provider: ResponseStreamLike<TEvent, TResponse>): void {
    if (this.#eventBridges.has(event)) return;
    const bridge = (...args: unknown[]) => this.#emitProvider(event, ...args);
    this.#eventBridges.set(event, bridge);
    provider.on(event, bridge);
  }

  #requestAbort(): void {
    if (this.#abortRequested) return;
    this.#abortRequested = true;
    if (this.#state === "new") {
      this.#state = "preaborted";
      const error = responseStreamAbortError();
      this.#recordTerminalFailure(error, "abort");
      this.#runPreStartAbortCleanup();
      return;
    }
    if (this.#state === "started") this.#delegateProviderAbort();
  }

  #delegateProviderAbort(): void {
    const provider = this.#provider;
    if (provider === undefined || this.#providerAbortDelegated) return;
    this.#providerAbortDelegated = true;
    try {
      provider.abort();
    } catch (error) {
      this.#warnCallbackFailure("provider abort", error);
    }
  }

  #mirrorProviderAbort(): void {
    this.#providerAbortDelegated = true;
    this.#abortRequested = true;
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  #runPreStartAbortCleanup(): void {
    let result: void | Promise<void>;
    try {
      result = this.#onAbortBeforeStart?.();
    } catch (error) {
      this.#warnCallbackFailure("pre-start abort cleanup", error);
      return;
    } finally {
      this.#onAbortBeforeStart = undefined;
      this.#start = undefined;
    }
    Promise.resolve(result).catch((error) => {
      this.#warnCallbackFailure("pre-start abort cleanup", error);
    });
  }

  #recordStartupFailure(error: unknown): void {
    if (this.#terminalFailure !== null) return;
    this.#state = "failed";
    this.#onAbortBeforeStart = undefined;
    this.#recordTerminalFailure(error, "startup");
    this.#emitSynthetic("error", error);
    this.#emitSynthetic("end");
  }

  #emitSynthetic(event: string, ...args: unknown[]): void {
    const listeners = this.#prepareEmission(event);
    for (const record of listeners) {
      try {
        record.original(...args);
      } catch (error) {
        this.#warnCallbackFailure("event listener", error);
      }
    }
  }

  #emitProvider(event: string, ...args: unknown[]): void {
    if (event === "error") this.#recordTerminalFailure(args[0], "provider");
    if (event === "abort") this.#recordTerminalFailure(args[0], "abort");
    if (event === "end") this.#ended = true;
    const listeners = this.#prepareEmission(event);
    for (const record of listeners) record.original(...args);
  }

  #recordTerminalFailure(error: unknown, kind: DeferredTerminalFailure["kind"]): void {
    if (this.#ended) return;
    const failure = { error, kind };
    this.#terminalFailure = failure;
    this.#ended = true;
    this.#aborted = kind === "abort" || this.#abortRequested;
    // Resolve/reject waiters before user event callbacks can throw. Callback
    // behavior cannot strand another consumer of the same terminal result.
    for (const waiter of [...this.#eventWaiters]) waiter(failure);
  }

  #prepareEmission(event: string): DeferredListenerRecord[] {
    const listeners = this.#listeners.filter((record) => record.active && record.event === event);
    for (const record of listeners) {
      if (record.once) this.#removeListener(record);
    }
    return listeners;
  }

  #warnCallbackFailure(context: DeferredCallbackFailureContext, error: unknown): void {
    try {
      switch (context) {
        case "provider abort":
          this.#logger.warn(
            "deferred Responses stream provider abort raised; suppressed (%s)",
            errorClassName(error),
          );
          break;
        case "pre-start abort cleanup":
          this.#logger.warn(
            "deferred Responses stream pre-start abort cleanup raised; suppressed (%s)",
            errorClassName(error),
          );
          break;
        case "event listener":
          this.#logger.warn(
            "deferred Responses stream event listener raised; suppressed (%s)",
            errorClassName(error),
          );
          break;
      }
    } catch {
      // Diagnostics are best-effort and never replace lifecycle outcomes.
    }
  }
}

/** Construction options for {@link StreamWrapper} / {@link wrapStream}. */
export interface StreamWrapperOptions {
  /** The inner async iterable of provider chunks. */
  stream: AsyncIterable<unknown>;
  /** Observes every raw chunk; settles final usage. */
  accumulator: StreamUsageAccumulator;
  /** Fired once on success. */
  onComplete: OnComplete;
  /** Fired once on error. */
  onError: OnError;
  /** `null`/omitted → strict passthrough (zero overhead, translator never invoked). */
  chunkTranslator?: ChunkTranslator | null;
  /** Synchronous stop check, evaluated only after pulling a raw provider item. */
  abortCheck?: (() => Error | undefined) | null;
  /** Releases the caller-owned abort watcher exactly once at terminal disposition. */
  abortRelease?: (() => void) | null;
  /** Logger for class-name-only callback-exception notices. */
  logger?: Logger;
  /**
   * Monotonic start timestamp (`performance.now()`-based) for the elapsed-ms the
   * `onComplete` callback receives. Defaults to wrapper-construction time; the client
   * passes the DISPATCH-start timestamp so streaming latency includes establishment
   * (connect + TTFB), matching Python's `ctx.elapsed_ms()` (F18).
   */
  startTime?: number;
}

/**
 * Observe the helper's event channel, which runs for every consumption API. Iteration
 * remains provider-owned: feeding both channels would count usage-bearing events twice.
 */
export function observeResponseStream(
  value: unknown,
  options: StreamWrapperOptions,
  onEntryError: OnError,
): ResponseStreamLike {
  if (!isResponseStreamLike(value)) {
    throw new SolwynError("Responses stream did not expose the required provider surface");
  }
  const provider = value;
  const logger = options.logger ?? consoleLogger;
  const accumulator = options.accumulator;
  const startTime = options.startTime ?? 0;
  let onComplete: OnComplete | undefined = options.onComplete;
  let onError: OnError | undefined = options.onError;
  let entryError: OnError | undefined = onEntryError;
  let abortCheck = options.abortCheck;
  let abortRelease = options.abortRelease;
  let connected = false;
  let settled = false;
  let stopped: Error | undefined;
  const listeners = new Map<string, ResponseStreamListener>();
  const subscriptions: Array<{
    event: string;
    original: ResponseStreamListener;
    wrapped: ResponseStreamListener;
  }> = [];
  const removeSubscription = (record: (typeof subscriptions)[number]): void => {
    const index = subscriptions.indexOf(record);
    if (index !== -1) subscriptions.splice(index, 1);
    provider.off(record.event, record.wrapped);
  };
  const cleanupSubscriptions = (): void => {
    for (const record of [...subscriptions]) removeSubscription(record);
  };
  const finish = (failed: boolean, error?: unknown): void => {
    if (settled) return;
    settled = true;
    let outcome: void | Promise<void>;
    try {
      if (failed) outcome = (connected ? onError : entryError)?.(error);
      else {
        const details = accumulator.finalize();
        outcome = onComplete?.(details, performance.now() - startTime);
      }
    } catch (error) {
      outcome = undefined;
      warn(error);
    } finally {
      for (const [event, listener] of listeners) provider.off(event, listener);
      abortRelease?.();
    }
    Promise.resolve(outcome)
      .catch(warn)
      .then(() => {
        onComplete = undefined;
        onError = undefined;
        entryError = undefined;
        abortCheck = null;
        abortRelease = null;
      });
  };
  const warn = (error: unknown): void => {
    try {
      logger.warn(
        "Responses stream observer callback raised; suppressed (%s)",
        errorClassName(error),
      );
    } catch {
      // Diagnostics never replace the provider outcome.
    }
  };
  const listen = (event: string, listener: ResponseStreamListener): void => {
    listeners.set(event, listener);
    provider.on(event, listener);
  };
  listen("connect", () => {
    connected = true;
  });
  listen("event", (event) => {
    if (settled) return;
    try {
      stopped = abortCheck?.();
      if (stopped !== undefined) {
        // Native EventStream snapshots listeners before invoking this observer. Abort
        // cannot retract that snapshot or its following typed event; every subscription
        // below checks this latch before delivery, and waiters receive the same error.
        for (const record of [...subscriptions]) {
          if (record.event !== "error") continue;
          try {
            record.original(stopped);
          } catch (error) {
            warn(error);
          }
        }
        cleanupSubscriptions();
        finish(false);
        provider.abort();
        return;
      }
      accumulator.observe(event);
    } catch (error) {
      finish(true, error);
      provider.abort();
    }
  });
  listen("error", (error) => finish(true, error));
  listen("abort", (error) => {
    // Before connect this is a rejected request entry, not abandoned generated output.
    if (connected) finish(false);
    else finish(true, error);
  });
  listen("response.completed", () => finish(false));
  listen("end", () => finish(false));
  // Observe the provider's terminal promise even for event-only consumers. This also
  // prevents a later provider rejection from becoming unhandled after terminal usage.
  provider.done().then(
    () => {
      finish(false);
      cleanupSubscriptions();
    },
    (error) => {
      finish(true, error);
      cleanupSubscriptions();
    },
  );
  const observeOutcome = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      if (stopped !== undefined) throw stopped;
      const result = await operation();
      if (stopped !== undefined) throw stopped;
      return result;
    } catch (error) {
      throw stopped ?? error;
    }
  };
  let proxy: ResponseStreamLike;
  const subscribe = (
    event: string,
    original: ResponseStreamListener,
    once: boolean,
  ): ResponseStreamLike => {
    const record = {
      event,
      original,
      wrapped: (...args: unknown[]) => {
        if (stopped !== undefined) return;
        if (once) removeSubscription(record);
        original(...args);
      },
    };
    subscriptions.push(record);
    provider.on(event, record.wrapped);
    return proxy;
  };
  const unsubscribe = (event: string, original: ResponseStreamListener): ResponseStreamLike => {
    const record = subscriptions.find((item) => item.event === event && item.original === original);
    if (record !== undefined) removeSubscription(record);
    return proxy;
  };
  proxy = new Proxy(provider, {
    get(target, property) {
      if (property === "on")
        return (event: string, listener: ResponseStreamListener) =>
          subscribe(event, listener, false);
      if (property === "once")
        return (event: string, listener: ResponseStreamListener) =>
          subscribe(event, listener, true);
      if (property === "off") return unsubscribe;
      if (property === "emitted")
        return (event: string) => {
          if (stopped !== undefined)
            return event === "error" ? Promise.resolve(stopped) : Promise.reject(stopped);
          return new Promise<unknown>((resolve, reject) => {
            const removePair = () => {
              unsubscribe(event, delivered);
              if (event !== "error") unsubscribe("error", failed);
            };
            const delivered = (value: unknown) => {
              removePair();
              resolve(value);
            };
            const failed = (error: unknown) => {
              removePair();
              reject(error);
            };
            subscribe(event, delivered, true);
            if (event !== "error") subscribe("error", failed, true);
          });
        };
      if (property === "done") return () => observeOutcome(() => target.done());
      if (property === "finalResponse") return () => observeOutcome(() => target.finalResponse());
      if (property === Symbol.asyncIterator) {
        return () => {
          const iterator = target[Symbol.asyncIterator]();
          return {
            next: () => observeOutcome(() => iterator.next()),
            return: async (result?: unknown) => {
              target.abort();
              return { done: true as const, value: result };
            },
          };
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return proxy;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const NON_SUCCESS_ABORT = Symbol("solwyn.stream.non-success-abort");

async function forwardClose(value: unknown): Promise<void> {
  const aclose = isObject(value) ? value["aclose"] : undefined;
  if (typeof aclose === "function") {
    await aclose.call(value);
    return;
  }
  const close = isObject(value) ? value["close"] : undefined;
  if (typeof close === "function") {
    await close.call(value);
    return;
  }
  await abortNativeStream(value);
}

/** Native eager streams own cancellation before their iterator has ever started. */
async function abortNativeStream(value: unknown): Promise<void> {
  const controller = isObject(value) ? value["controller"] : undefined;
  if (!isObject(controller)) return;
  const signal = controller["signal"];
  if (isObject(signal) && signal["aborted"] === true) return;
  const abort = controller["abort"];
  if (typeof abort === "function") await abort.call(controller);
}

/** @internal Dispose a not-yet-transferred source without firing settlement callbacks. */
export async function abortStream(value: unknown): Promise<void> {
  const abort = isObject(value) ? Reflect.get(value, NON_SUCCESS_ABORT, value) : undefined;
  if (typeof abort === "function") {
    await abort.call(value);
    return;
  }
  await forwardClose(value);
}

/** Minimal, content-free tag from trusted intrinsic error classes or inert `typeof`. */
function errorClassName(error: unknown): string {
  try {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) return "DOMException";
    if (typeof AggregateError !== "undefined" && error instanceof AggregateError) {
      return "AggregateError";
    }
    if (error instanceof EvalError) return "EvalError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof ReferenceError) return "ReferenceError";
    if (error instanceof SyntaxError) return "SyntaxError";
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof URIError) return "URIError";
    if (error instanceof Error) return "Error";
  } catch {
    // Hostile proxies may trap prototype access. Fall through to inert metadata.
  }
  return typeof error;
}

interface AbortReleaseState {
  readonly callback: () => void;
  released: boolean;
}

function releaseAbortState(state: AbortReleaseState): void {
  if (state.released) {
    return;
  }
  state.released = true;
  try {
    state.callback();
  } catch {
    // Release is lifecycle bookkeeping and must not replace the terminal disposition.
  }
}

const abortReleaseRegistry =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<AbortReleaseState>((state) => releaseAbortState(state))
    : null;

/**
 * Wraps an `AsyncIterable<unknown>`, tees every chunk to a {@link StreamUsageAccumulator},
 * and settles exactly once. Iterate with `for await`; dispose with `close()` or
 * `await using`. Unknown property access is transparently delegated to the inner stream
 * when this instance is obtained via {@link wrapStream} (which installs the passthrough
 * Proxy).
 */
export class StreamWrapper implements AsyncIterableIterator<unknown> {
  readonly #stream: AsyncIterable<unknown>;
  readonly #accumulator: StreamUsageAccumulator;
  #onComplete: OnComplete | undefined;
  #onError: OnError | undefined;
  #translationCursor: ChunkTranslationCursor | null;
  #abortCheck: (() => Error | undefined) | null;
  readonly #logger: Logger;
  readonly #startTime: number;
  #abortReleaseState: AbortReleaseState | null;
  readonly #abortReleaseToken = {};
  /** Guards once-only settlement — checked-and-set synchronously (no await between). */
  #settled = false;
  #terminal = false;
  #abortError: Error | undefined;
  #iterator: AsyncIterator<unknown> | undefined;
  #iteratorNaturallyFinished = false;
  #iteratorCleanupComplete = false;
  #sourceCleanupComplete = false;
  #abortCleanupWarningIssued = false;
  #operationTail: Promise<void> | null = null;
  #consumer: "iteration" | "helper" | null = null;

  constructor(options: StreamWrapperOptions) {
    this.#stream = options.stream;
    this.#accumulator = options.accumulator;
    this.#onComplete = options.onComplete;
    this.#onError = options.onError;
    this.#translationCursor = options.chunkTranslator
      ? createChunkTranslationCursor(options.chunkTranslator)
      : null;
    this.#abortCheck = options.abortCheck ?? null;
    this.#logger = options.logger ?? consoleLogger;
    this.#startTime = options.startTime ?? performance.now();
    this.#abortReleaseState = options.abortRelease
      ? { callback: options.abortRelease, released: false }
      : null;
    if (this.#abortReleaseState !== null) {
      abortReleaseRegistry?.register(this, this.#abortReleaseState, this.#abortReleaseToken);
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this;
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.#consumer === "helper") {
      return Promise.reject(new SolwynError("stream already has a consumer; consume its helper"));
    }
    this.#consumer = "iteration";
    return this.#enqueue(() => this.#nextInside());
  }

  #conversion(): StreamConversion {
    if (this.#consumer !== null) {
      throw new SolwynError("stream already has a consumer; use tee() before consuming it");
    }
    this.#consumer = "helper";
    const controller = isObject(this.#stream) ? this.#stream["controller"] : undefined;
    return new StreamConversion(
      {
        next: () => this.#enqueue(() => this.#nextInside()),
        return: () => this.return(),
        throw: (error) => this.throw(error),
      },
      controller,
    );
  }

  tee(): [StreamConversion, StreamConversion] {
    return this.#conversion().tee();
  }

  toReadableStream(): ReadableStream<Uint8Array> {
    return this.#conversion().toReadableStream();
  }

  return(value?: unknown): Promise<IteratorResult<unknown>> {
    return this.#enqueue(() => this.#returnInside(value));
  }

  throw(error?: unknown): Promise<IteratorResult<unknown>> {
    return this.#enqueue(() => this.#throwInside(error));
  }

  /**
   * Settle with whatever the accumulator has observed so far (partial data on early
   * abort), then forward cleanup to the inner stream. Idempotent for settlement:
   * a second `close()` — or a `close()` after error/exhaustion — never re-fires a
   * callback.
   */
  async close(): Promise<void> {
    await this.#enqueue(() => this.#closeInside());
  }

  /** Provider-style alias routed through the same serialized cleanup path as close(). */
  async aclose(): Promise<void> {
    await this.close();
  }

  /** `await using` disposal — delegates to {@link close}. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** @internal Construction-failure cleanup; unlike close(), this is never success. */
  async [NON_SUCCESS_ABORT](): Promise<void> {
    await this.#enqueue(async () => {
      this.#terminal = true;
      this.#settled = true;
      this.#translationCursor?.clear();
      this.#releaseAbort();
      try {
        await this.#cleanupInside();
      } finally {
        this.#releaseTerminalCallbacks();
      }
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = (this.#operationTail ?? Promise.resolve()).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#operationTail = tail;
    void tail.then(() => {
      // A settled promise created inside Node ALS can itself retain the run frame.
      // Drop the final queue link only when no later operation has been enqueued.
      if (this.#terminal && this.#operationTail === tail) this.#operationTail = null;
    });
    return result;
  }

  async #nextInside(): Promise<IteratorResult<unknown>> {
    if (this.#abortError !== undefined) {
      throw this.#abortError;
    }
    if (this.#terminal) {
      return { done: true, value: undefined };
    }

    const cursor = this.#translationCursor;
    if (cursor !== null) {
      const buffered = cursor.take();
      if (!buffered.done) return buffered;
    }

    try {
      while (true) {
        const iterator = this.#getIterator();
        const pulled = await iterator.next();
        if (pulled.done) {
          this.#iteratorNaturallyFinished = true;
          this.#terminal = true;
          await this.#settle();
          return { done: true, value: pulled.value };
        }

        const abortError = this.#abortCheck?.();
        if (abortError !== undefined) {
          this.#abortError = abortError;
          this.#terminal = true;
          cursor?.clear();
          await this.#abortInside();
          throw abortError;
        }

        // Observe the RAW served item before translating it. The item itself remains opaque.
        this.#accumulator.observe(pulled.value);
        if (cursor === null) {
          return { done: false, value: pulled.value };
        }
        cursor.push(pulled.value);
        const translated = cursor.take();
        if (!translated.done) return translated;
      }
    } catch (error) {
      if (this.#abortError !== undefined) {
        throw this.#abortError;
      }
      await this.#ordinaryFailureInside(error);
      throw error;
    }
  }

  #getIterator(): AsyncIterator<unknown> {
    if (this.#iterator === undefined) {
      this.#iterator = this.#stream[Symbol.asyncIterator]();
    }
    return this.#iterator;
  }

  async #returnInside(value: unknown): Promise<IteratorResult<unknown>> {
    this.#terminal = true;
    this.#translationCursor?.clear();
    if (this.#abortError !== undefined) {
      await this.#retryAbortCleanupInside();
    } else {
      await this.#settleAndCleanupInside();
    }
    return { done: true, value };
  }

  async #throwInside(error: unknown): Promise<IteratorResult<unknown>> {
    if (this.#abortError !== undefined) {
      await this.#retryAbortCleanupInside();
      throw this.#abortError;
    }
    if (!this.#terminal) {
      await this.#ordinaryFailureInside(error);
    }
    throw error;
  }

  async #closeInside(): Promise<void> {
    this.#terminal = true;
    this.#translationCursor?.clear();
    if (this.#abortError !== undefined) {
      await this.#retryAbortCleanupInside();
      return;
    }
    await this.#settleAndCleanupInside();
  }

  async #settleAndCleanupInside(): Promise<void> {
    let settlementFailure: { readonly error: unknown } | null = null;
    try {
      await this.#settle();
    } catch (error) {
      settlementFailure = { error };
    }
    try {
      await this.#cleanupInside();
    } catch (cleanupError) {
      if (settlementFailure === null) {
        throw cleanupError;
      }
    }
    if (settlementFailure !== null) {
      throw settlementFailure.error;
    }
  }

  async #abortInside(): Promise<void> {
    try {
      await this.#settle();
    } catch {
      // A latched cooperative stop remains authoritative over finalization failure.
    }
    await this.#retryAbortCleanupInside();
  }

  async #retryAbortCleanupInside(): Promise<void> {
    try {
      await this.#cleanupInside();
    } catch (cleanupError) {
      if (this.#abortCleanupWarningIssued) {
        return;
      }
      this.#abortCleanupWarningIssued = true;
      try {
        this.#logger.warn(
          "provider close raised during run-stop abort; suppressing (%s)",
          errorClassName(cleanupError),
        );
      } catch {
        // Diagnostics are best-effort; a caller-owned logger cannot mask the stop.
      }
    }
  }

  async #ordinaryFailureInside(error: unknown): Promise<void> {
    this.#terminal = true;
    this.#translationCursor?.clear();
    try {
      await this.#settleError(error);
    } finally {
      try {
        await this.#cleanupInside();
      } catch {
        // The original processing/settlement failure has precedence over cleanup.
      }
    }
  }

  async #settle(): Promise<void> {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    try {
      const elapsedMs = performance.now() - this.#startTime;
      let tokenDetails: TokenDetails;
      try {
        tokenDetails = this.#accumulator.finalize();
      } catch (error) {
        await this.#notifyError(error);
        throw error;
      }
      try {
        await this.#onComplete?.(tokenDetails, elapsedMs);
      } catch (callbackError) {
        // WARNING, not ERROR: a user callback throwing is not an SDK-level error — Python's
        // `stream.py` logs the suppressed callback exception at `logger.warning` (behavior of
        // record). Structural-only, no message/exc_info (privacy: a callback error can carry a
        // provider exception's stringified content).
        try {
          this.#logger.warn(
            `stream: onComplete callback raised ${errorClassName(callbackError)}; suppressed`,
          );
        } catch {
          // Diagnostics are best-effort.
        }
      }
    } finally {
      this.#releaseAbort();
      this.#releaseTerminalCallbacks();
    }
  }

  async #settleError(error: unknown): Promise<void> {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    try {
      await this.#notifyError(error);
    } finally {
      this.#releaseAbort();
      this.#releaseTerminalCallbacks();
    }
  }

  async #notifyError(error: unknown): Promise<void> {
    try {
      await this.#onError?.(error);
    } catch (callbackError) {
      // WARNING, not ERROR — see `#settle`: a suppressed user-callback exception is not an
      // SDK-level error (parity with Python `stream.py`'s `logger.warning`).
      try {
        this.#logger.warn(
          `stream: onError callback raised ${errorClassName(callbackError)}; suppressed`,
        );
      } catch {
        // Diagnostics are best-effort.
      }
    }
  }

  #releaseAbort(): void {
    const state = this.#abortReleaseState;
    this.#abortReleaseState = null;
    if (state === null) {
      return;
    }
    abortReleaseRegistry?.unregister(this.#abortReleaseToken);
    releaseAbortState(state);
  }

  #releaseTerminalCallbacks(): void {
    this.#onComplete = undefined;
    this.#onError = undefined;
    this.#abortCheck = null;
    this.#translationCursor?.clear();
    this.#translationCursor = null;
  }

  async #cleanupInside(): Promise<void> {
    let firstFailure: { readonly error: unknown } | null = null;
    let iteratorReturn: ((value?: unknown) => PromiseLike<IteratorResult<unknown>>) | undefined;

    const iterator = this.#iterator;
    if (
      iterator !== undefined &&
      !this.#iteratorNaturallyFinished &&
      !this.#iteratorCleanupComplete
    ) {
      try {
        const candidate = iterator.return;
        if (typeof candidate === "function") {
          iteratorReturn = candidate;
          await candidate.call(iterator);
        }
        this.#iteratorCleanupComplete = true;
      } catch (error) {
        firstFailure = { error };
      }
    }

    if (!this.#sourceCleanupComplete) {
      try {
        const source = this.#stream;
        const aclose = isObject(source) ? source["aclose"] : undefined;
        const close =
          typeof aclose === "function" ? undefined : isObject(source) ? source["close"] : undefined;
        const sourceCleanup = typeof aclose === "function" ? aclose : close;
        if (typeof sourceCleanup === "function") {
          if ((source as unknown) === iterator && sourceCleanup === iteratorReturn) {
            if (this.#iteratorCleanupComplete) {
              this.#sourceCleanupComplete = true;
            }
          } else {
            await sourceCleanup.call(source);
            this.#sourceCleanupComplete = true;
          }
        } else {
          if (!this.#iteratorNaturallyFinished) await abortNativeStream(source);
          this.#sourceCleanupComplete = true;
        }
      } catch (error) {
        if (firstFailure === null) {
          firstFailure = { error };
        }
      }
    }

    if (firstFailure !== null) {
      throw firstFailure.error;
    }
  }
}

/**
 * Build a {@link StreamWrapper} wrapped in an attribute-passthrough Proxy: the
 * wrapper's own surface (`Symbol.asyncIterator`, `close`, `Symbol.asyncDispose`) wins;
 * every other property access delegates transparently to the inner stream
 * (`wrapper.response.status`-style access resolves through). Wrapper methods are bound
 * to the real instance so private-field access survives the Proxy indirection.
 */
export function wrapStream(options: StreamWrapperOptions): StreamWrapper {
  const wrapper = new StreamWrapper(options);
  const inner = options.stream;
  return new Proxy(wrapper, {
    get(target, prop, receiver): unknown {
      if (prop === Symbol.asyncIterator) {
        return () => receiver;
      }
      if (Reflect.has(target, prop)) {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (isObject(inner)) {
        const value = Reflect.get(inner, prop, inner);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(inner)
          : value;
      }
      return undefined;
    },
    has(target, prop): boolean {
      return Reflect.has(target, prop) || (isObject(inner) && Reflect.has(inner, prop));
    },
  });
}

/**
 * Failover materialization seam — INTENTIONALLY unimplemented until M4.
 *
 * Cross-dialect stream failover materializes a foreign-dialect served stream into
 * caller-dialect chunks via the content-privileged `src/providers/translation/`
 * package. That translation is M4 work; `wrapStream`'s `chunkTranslator` parameter is
 * the injection point M4 will wire a real translator into. Until then this seam MUST
 * fail loudly rather than silently degrade — a same-dialect failover never reaches it
 * (it uses passthrough, `chunkTranslator === null`), so any invocation here is a
 * cross-dialect path that does not yet exist.
 */
export function materializeStreamForFailover(_servedStream: unknown, _options?: unknown): never {
  throw new SolwynError(
    "cross-dialect stream failover materialization is not implemented until M4",
  );
}
