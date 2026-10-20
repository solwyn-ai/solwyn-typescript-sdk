import { afterEach, describe, expect, it } from "vitest";
import { noopLogger } from "../../src/logging";
import { MetadataReporter } from "../../src/reporter";
import { FakeControlPlane } from "../../src/testing";
import {
  applyTraceFields,
  captureTrace,
  validatedTrace,
  withoutTraceContext,
} from "../../src/trace-context";
import type { MetadataEvent } from "../../src/types";

const REGISTRY_KEY = Symbol.for("opentelemetry.js.api.1");
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
const BAGGAGE_KEY = Symbol.for("OpenTelemetry Baggage Key");
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

type Registry = Record<string | symbol, unknown>;

/** Minimal immutable context with the API's getValue/setValue/deleteValue protocol. */
class FakeContext {
  readonly #values: Map<symbol, unknown>;
  constructor(values: Map<symbol, unknown> = new Map()) {
    this.#values = values;
  }
  getValue(key: symbol): unknown {
    return this.#values.get(key);
  }
  setValue(key: symbol, value: unknown): FakeContext {
    return new FakeContext(new Map(this.#values).set(key, value));
  }
  deleteValue(key: symbol): FakeContext {
    const values = new Map(this.#values);
    values.delete(key);
    return new FakeContext(values);
  }
}

/** Synchronous stack-based context manager (the shape the registry's `context` slot holds). */
class FakeContextManager {
  current = new FakeContext();
  active(): FakeContext {
    return this.current;
  }
  with<T>(context: FakeContext, fn: () => T): T {
    const previous = this.current;
    this.current = context;
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }
}

function spanWith(spanContext: unknown): { spanContext(): unknown } {
  return { spanContext: () => spanContext };
}

function install(manager: unknown = new FakeContextManager(), version = "1.9.1"): Registry {
  const registry: Registry = { version, context: manager };
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
  return registry;
}

function installWithSpan(span: unknown): FakeContextManager {
  const manager = new FakeContextManager();
  manager.current = manager.current.setValue(SPAN_KEY, span);
  install(manager);
  return manager;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
});

describe("captureTrace", () => {
  it("returns undefined when no OpenTelemetry API registered anything", () => {
    expect(captureTrace()).toBeUndefined();
  });

  it.each([
    ["a registry without a context manager", { version: "1.9.1" }],
    ["a non-object registry", "1.9.1"],
    ["a future major's registry shape", { version: "2.0.0", context: new FakeContextManager() }],
    ["a registry without a version", { context: new FakeContextManager() }],
    ["a manager without active()", { version: "1.9.1", context: {} }],
  ])("returns undefined for %s", (_label, registry) => {
    (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
    expect(captureTrace()).toBeUndefined();
  });

  it("returns undefined when the active context holds no span", () => {
    install();
    expect(captureTrace()).toBeUndefined();
  });

  it.each([
    [1, true],
    [0, false],
    [3, true],
    [2, false],
  ])("captures ids and the sampled bit from trace flags %s", (traceFlags, sampled) => {
    installWithSpan(spanWith({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags }));
    const snapshot = captureTrace();
    expect(snapshot).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("normalizes uppercase hex to the lowercase W3C form", () => {
    installWithSpan(
      spanWith({ traceId: TRACE_ID.toUpperCase(), spanId: SPAN_ID.toUpperCase(), traceFlags: 1 }),
    );
    expect(captureTrace()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
  });

  it.each([
    ["an all-zero trace id", { traceId: "0".repeat(32), spanId: SPAN_ID, traceFlags: 1 }],
    ["an all-zero span id", { traceId: TRACE_ID, spanId: "0".repeat(16), traceFlags: 1 }],
    ["a short trace id", { traceId: TRACE_ID.slice(1), spanId: SPAN_ID, traceFlags: 1 }],
    ["a long span id", { traceId: TRACE_ID, spanId: `${SPAN_ID}0`, traceFlags: 1 }],
    ["a non-hex trace id", { traceId: `g${TRACE_ID.slice(1)}`, spanId: SPAN_ID, traceFlags: 1 }],
    ["a newline suffix", { traceId: `${TRACE_ID}\n`, spanId: SPAN_ID, traceFlags: 1 }],
    ["a numeric trace id", { traceId: 1, spanId: SPAN_ID, traceFlags: 1 }],
    ["a missing span id", { traceId: TRACE_ID, traceFlags: 1 }],
    ["string trace flags", { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: "1" }],
    ["fractional trace flags", { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1.5 }],
    ["missing trace flags", { traceId: TRACE_ID, spanId: SPAN_ID }],
    ["a null span context", null],
    ["a primitive span context", "context"],
  ])("discards %s", (_label, spanContext) => {
    installWithSpan(spanWith(spanContext));
    expect(captureTrace()).toBeUndefined();
  });

  it.each([
    ["a span without spanContext()", { name: "span" }],
    ["a primitive span", "span"],
  ])("discards %s", (_label, span) => {
    installWithSpan(span);
    expect(captureTrace()).toBeUndefined();
  });

  it.each([
    [
      "active() throws",
      () =>
        install({
          active() {
            throw new Error("boom");
          },
        }),
    ],
    [
      "getValue() throws",
      () =>
        install({
          active: () => ({
            getValue() {
              throw new Error("boom");
            },
          }),
        }),
    ],
    [
      "spanContext() throws",
      () =>
        installWithSpan({
          spanContext() {
            throw new Error("boom");
          },
        }),
    ],
    [
      "a span-context getter throws",
      () =>
        installWithSpan(
          spanWith({
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            get traceFlags(): number {
              throw new Error("boom");
            },
          }),
        ),
    ],
    [
      "the registry version getter throws",
      () => {
        (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = {
          get version(): string {
            throw new Error("boom");
          },
        };
      },
    ],
  ])("fails soft when %s", (_label, arrange) => {
    arrange();
    expect(captureTrace()).toBeUndefined();
  });

  it("reads only spanContext() on the span and only ids and flags on its context", () => {
    const spanReads: PropertyKey[] = [];
    const contextReads: PropertyKey[] = [];
    const spanContext = new Proxy(
      { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1, traceState: "vendor=secret" },
      {
        get(target, key, receiver) {
          contextReads.push(key);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const span = new Proxy(
      { spanContext: () => spanContext, attributes: { "gen_ai.input.messages": "secret" } },
      {
        get(target, key, receiver) {
          spanReads.push(key);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    installWithSpan(span);

    expect(captureTrace()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
    expect(spanReads).toEqual(["spanContext"]);
    expect([...contextReads].sort()).toEqual(["spanId", "traceFlags", "traceId"]);
  });
});

describe("validatedTrace and applyTraceFields", () => {
  it.each([
    ["an undefined snapshot", undefined],
    ["a non-boolean sampled flag", { traceId: TRACE_ID, spanId: SPAN_ID, sampled: 1 }],
    ["a missing sampled flag", { traceId: TRACE_ID, spanId: SPAN_ID }],
    ["an all-zero trace id", { traceId: "0".repeat(32), spanId: SPAN_ID, sampled: true }],
    ["a malformed span id", { traceId: TRACE_ID, spanId: "xyz", sampled: true }],
  ])("omits every trace field for %s", (_label, snapshot) => {
    const event: Partial<MetadataEvent> = {};
    applyTraceFields(event, snapshot);
    expect(event).toEqual({});
    expect(validatedTrace(snapshot)).toBeUndefined();
  });

  it("stamps all three fields together and keeps an unsampled flag", () => {
    const event: Partial<MetadataEvent> = {};
    applyTraceFields(event, { traceId: TRACE_ID, spanId: SPAN_ID, sampled: false });
    expect(event).toEqual({ trace_id: TRACE_ID, span_id: SPAN_ID, trace_sampled: false });
  });
});

describe("withoutTraceContext", () => {
  const CUSTOM_KEY = Symbol("application key");

  it("runs directly without a registered context manager", () => {
    expect(withoutTraceContext(() => 42)).toBe(42);
  });

  it("removes the span and baggage, keeps other values, and restores the caller", () => {
    const manager = new FakeContextManager();
    manager.current = manager.current
      .setValue(SPAN_KEY, spanWith({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }))
      .setValue(BAGGAGE_KEY, { entries: "secret" })
      .setValue(CUSTOM_KEY, "kept");
    install(manager);
    const callerContext = manager.current;

    const seen = withoutTraceContext(() => {
      const active = manager.active();
      return [active.getValue(SPAN_KEY), active.getValue(BAGGAGE_KEY), active.getValue(CUSTOM_KEY)];
    });

    expect(seen).toEqual([undefined, undefined, "kept"]);
    expect(manager.current).toBe(callerContext);
    expect(captureTrace()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
  });

  it("does not enter a new context when neither a span nor baggage is active", () => {
    const manager = new FakeContextManager();
    let entered = 0;
    const original = manager.with.bind(manager);
    manager.with = (context, fn) => {
      entered += 1;
      return original(context, fn);
    };
    install(manager);
    expect(withoutTraceContext(() => "ok")).toBe("ok");
    expect(entered).toBe(0);
  });

  it("propagates the callback's own error and runs it exactly once", () => {
    installWithSpan(spanWith({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }));
    let runs = 0;
    const failure = new Error("callback failure");
    expect(() =>
      withoutTraceContext(() => {
        runs += 1;
        throw failure;
      }),
    ).toThrow(failure);
    expect(runs).toBe(1);
  });

  it("falls back to the current context when the manager fails before entering", () => {
    const manager = new FakeContextManager();
    manager.current = manager.current.setValue(SPAN_KEY, spanWith({}));
    manager.with = () => {
      throw new Error("manager failure");
    };
    install(manager);
    let runs = 0;
    expect(
      withoutTraceContext(() => {
        runs += 1;
        return "ran";
      }),
    ).toBe("ran");
    expect(runs).toBe(1);
  });

  it("keeps the callback's result when the manager fails after running it", () => {
    const manager = installWithSpan(spanWith({}));
    manager.with = (context, fn) => {
      FakeContextManager.prototype.with.call(manager, context, fn);
      throw new Error("manager failure while restoring");
    };
    const result = Promise.resolve("delivered");
    let runs = 0;
    expect(
      withoutTraceContext(() => {
        runs += 1;
        return result;
      }),
    ).toBe(result);
    expect(runs).toBe(1);
  });

  it("propagates the callback's own error, not the manager's, when both fail", () => {
    const manager = installWithSpan(spanWith({}));
    manager.with = (context, fn) => {
      try {
        FakeContextManager.prototype.with.call(manager, context, fn);
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: simulates a hostile manager.
        throw new Error("manager failure while restoring");
      }
    };
    const failure = new Error("callback failure");
    let runs = 0;
    expect(() =>
      withoutTraceContext(() => {
        runs += 1;
        throw failure;
      }),
    ).toThrow(failure);
    expect(runs).toBe(1);
  });

  it("ignores a substituted return value and a repeated invocation from the manager", () => {
    const manager = installWithSpan(spanWith({}));
    manager.with = (context, fn) => {
      FakeContextManager.prototype.with.call(manager, context, fn);
      FakeContextManager.prototype.with.call(manager, context, fn);
      return "substituted" as never;
    };
    let runs = 0;
    expect(
      withoutTraceContext(() => {
        runs += 1;
        return "original";
      }),
    ).toBe("original");
    expect(runs).toBe(1);
  });

  it("still delivers close-time spend when the manager fails while restoring", async () => {
    const manager = installWithSpan(
      spanWith({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }),
    );
    manager.with = (context, fn) => {
      const result = FakeContextManager.prototype.with.call(manager, context, fn);
      throw new Error(`manager failure while restoring ${typeof result}`);
    };
    const plane = new FakeControlPlane();
    const reporter = new MetadataReporter(plane.apiUrl, plane.apiKey, {
      fetch: plane.fetch,
      sdkInstanceId: "manager-failure",
      logger: noopLogger,
    });
    reporter.report({
      model: "gpt-5-mini",
      provider: "openai",
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 0,
      status: "success",
      is_model_fallback: false,
      is_provider_fallback: false,
      attempt_index: 0,
      sdk_instance_id: "manager-failure",
      call_id: crypto.randomUUID(),
      timestamp: reporter.nextEventTimestamp(),
    } satisfies MetadataEvent);
    await reporter.close();
    expect(plane.ingested).toHaveLength(1);
  });

  it("runs directly when the context cannot drop its span", () => {
    const stubborn = {
      getValue: (key: symbol) => (key === SPAN_KEY ? "span" : undefined),
      deleteValue: () => stubborn,
    };
    let entered = 0;
    install({
      active: () => stubborn,
      with: (_context: unknown, fn: () => unknown) => {
        entered += 1;
        return fn();
      },
    });
    expect(withoutTraceContext(() => "ran")).toBe("ran");
    expect(entered).toBe(0);
  });

  it("runs directly when active() throws", () => {
    install({
      active() {
        throw new Error("boom");
      },
      with: () => {
        throw new Error("must not enter");
      },
    });
    expect(withoutTraceContext(() => "ran")).toBe("ran");
  });
});
