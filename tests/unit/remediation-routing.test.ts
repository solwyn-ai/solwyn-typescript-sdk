import { GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SolwynOptions } from "../../src/client";
import { ProviderUnavailableError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import {
  classifyException,
  Disposition,
  HealthBasedPolicy,
  retryAfterSeconds,
} from "../../src/routing";
import type { FetchLike } from "../../src/transport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function options(extra: SolwynOptions = {}): SolwynOptions {
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/budgets/check")) {
      return Response.json({
        allowed: true,
        remaining_budget: 1_000,
        reservation_id: null,
        mode: "hard_deny",
        budget_limit: 1_000,
        current_usage: 0,
        denied_by_period: null,
        project_id: `proj_${"0".repeat(24)}`,
        price_hints: null,
      });
    }
    if (url.endsWith("/metadata/ingest")) {
      const events = JSON.parse(init?.body as string) as unknown[];
      return Response.json({ ingested: events.length, rejected: [] }, { status: 202 });
    }
    if (url.includes("/breaker-reports")) return new Response(null, { status: 204 });
    throw new Error("unexpected offline control route");
  };
  return {
    apiKey: `sk_proj_${"0".repeat(64)}`,
    apiUrl: "https://control.invalid",
    fetch,
    logger: noopLogger,
    leaseEnabled: false,
    velocityMode: "off",
    reportUntrackedSurfaces: false,
    circuitBreakerRecoveryTimeoutJitter: 0,
    ...extra,
  };
}

describe("remediation 12: native Google fetch failures", () => {
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "ALL_PRE_SEND_AGGREGATE",
  ])("fails over for native TypeError carrying %s pre-send proof", async (code) => {
    const cause =
      code === "ALL_PRE_SEND_AGGREGATE"
        ? new AggregateError([
            Object.assign(new Error(), { code: "ECONNREFUSED" }),
            Object.assign(new Error(), { code: "ENOTFOUND" }),
          ])
        : Object.assign(new Error(), { code });
    const nativeError = new TypeError("", { cause });
    const providerFetch = vi.fn<typeof fetch>().mockRejectedValue(nativeError);
    vi.stubGlobal("fetch", providerFetch);
    const primary = new GoogleGenAI({ apiKey: "offline", vertexai: false });
    const served = { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1 } };
    const fallbackCreate = vi.fn().mockResolvedValue(served);
    const fallback = {
      models: { generateContent: fallbackCreate, generateContentStream: async function* () {} },
    };
    const sdk = new Solwyn(
      primary,
      options({ provider: "google", fallback: [[fallback, "gemini-2.5-pro"]] }),
    );
    try {
      expect(
        await sdk.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [] }],
        }),
      ).toEqual(served);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(fallbackCreate).toHaveBeenCalledTimes(1);
    } finally {
      await sdk.close();
    }
  });

  it.each([
    new TypeError(),
    new TypeError("", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }),
    new TypeError("", { cause: Object.assign(new Error(), { name: "ReadTimeout" }) }),
    new TypeError("", { cause: new Error() }),
    new TypeError("", {
      cause: new AggregateError([
        Object.assign(new Error(), { code: "ECONNREFUSED" }),
        new Error(),
      ]),
    }),
    new TypeError("", {
      cause: new AggregateError([
        Object.assign(new Error(), { code: "ECONNREFUSED" }),
        Object.assign(new Error(), { name: "SocketError", code: "UND_ERR_SOCKET" }),
      ]),
    }),
  ])("keeps uncertain native errors on the original provider", async (nativeError) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(nativeError));
    const fallbackCreate = vi.fn();
    const fallback = {
      models: { generateContent: fallbackCreate, generateContentStream: async function* () {} },
    };
    const sdk = new Solwyn(
      new GoogleGenAI({ apiKey: "offline", vertexai: false }),
      options({ provider: "google", fallback: [[fallback, "gemini-2.5-pro"]] }),
    );
    try {
      await expect(
        sdk.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [] }],
        }),
      ).rejects.toBe(nativeError);
      expect(fallbackCreate).not.toHaveBeenCalled();
    } finally {
      await sdk.close();
    }
  });

  it("conflicting aggregate causes retain ambiguous-success protection", () => {
    const mixed = new TypeError("", {
      cause: new AggregateError([
        Object.assign(new Error(), { code: "ECONNREFUSED" }),
        Object.assign(new Error(), { code: "ECONNRESET" }),
      ]),
    });
    expect(classifyException(mixed)).not.toBe(Disposition.FAILOVER);
  });

  it("bounds cause depth and breadth and honors a read failure despite attached 429", () => {
    const proof = Object.assign(new Error(), { code: "ECONNREFUSED" });
    const broad = new TypeError("", {
      cause: new AggregateError(Array.from({ length: 33 }, () => proof)),
    });
    let deep: Error = proof;
    for (let depth = 0; depth < 8; depth += 1) deep = new Error("", { cause: deep });
    const read = Object.assign(
      new TypeError("", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }),
      { status: 429 },
    );
    for (const error of [broad, new TypeError("", { cause: deep }), read]) {
      expect(classifyException(error)).toBe(Disposition.POST_SEND_AMBIGUOUS);
    }
  });

  it.each([
    false,
    true,
  ])("native Google read failures do not retry paid streams (after item: %s)", async (afterFirst) => {
    for (const nativeError of [
      new TypeError("", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }),
      new DOMException("", "TimeoutError"),
      Object.assign(new Error(), { status: 503 }),
    ]) {
      let pulls = 0;
      const usage = { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1 } };
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (afterFirst && pulls === 1) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(usage)}\n\n`));
            } else controller.error(nativeError);
          },
        },
        { highWaterMark: 0 },
      );
      const providerFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(body, { headers: { "content-type": "text/event-stream" } }),
        );
      vi.stubGlobal("fetch", providerFetch);
      const fallbackStream = vi.fn(async function* () {
        yield usage;
      });
      const fallback = {
        models: { generateContent: async () => usage, generateContentStream: fallbackStream },
      };
      const sdk = new Solwyn(
        new GoogleGenAI({ apiKey: "offline", vertexai: false }),
        options({ provider: "google", fallback: [[fallback, "gemini-2.5-pro"]] }),
      );
      let observed = 0;
      try {
        const consume = async () => {
          const source = await sdk.models.generateContentStream({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts: [] }],
          });
          for await (const _item of source) observed += 1;
        };
        expect(
          await consume().then(
            () => false,
            (error) => error === nativeError,
          ),
        ).toBe(true);
        expect(observed).toBe(afterFirst ? 1 : 0);
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(fallbackStream).not.toHaveBeenCalled();
        expect(body.locked).toBe(false);
      } finally {
        await sdk.close();
      }
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("remediation 13: public asynchronous admission interleavings", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("a delayed call cannot change another call's probe (stream: %s, failure: %s)", async (stream, failure) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const old = deferred<void>();
    const recovery = deferred<void>();
    const response = { usage: { prompt_tokens: 0, completion_tokens: 1 } };
    const error = Object.assign(new Error(), { status: 429 });
    let calls = 0;
    const create = async (_request: Record<string, unknown>): Promise<unknown> => {
      calls += 1;
      if (calls === 1) {
        if (stream)
          return (async function* () {
            await old.promise;
            if (failure) throw error;
            yield response;
          })();
        await old.promise;
        if (failure) throw error;
        return response;
      }
      if (calls === 2) throw error;
      await recovery.promise;
      return response;
    };
    const sdk = new Solwyn(
      { chat: { completions: { create } } },
      options({
        circuitBreakerFailureThreshold: 1,
        circuitBreakerRecoveryTimeout: 1,
        circuitBreakerSuccessThreshold: 2,
      }),
    );
    const call = (isStream = false) =>
      sdk.chat.completions.create({ model: "gpt-4o", messages: [], stream: isStream });
    const first = (async () => {
      const value = await call(stream);
      if (stream)
        for await (const _item of value as AsyncIterable<unknown>) {
          /* consume */
        }
      return value;
    })().then(
      () => true,
      () => false,
    );
    let probe: Promise<unknown> | undefined;
    let additional: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(calls).toBe(1));
      await expect(call()).rejects.toBe(error);
      now = 1_000;
      probe = call();
      await vi.waitFor(() => expect(calls).toBe(3));
      await expect(call()).rejects.toBeInstanceOf(ProviderUnavailableError);
      old.resolve();
      expect(await first).toBe(!failure);
      let additionalOutcome: { error?: unknown } | undefined;
      additional = call().then(
        () => {
          additionalOutcome = {};
        },
        (error: unknown) => {
          additionalOutcome = { error };
        },
      );
      await vi.waitFor(() => expect(additionalOutcome !== undefined || calls >= 4).toBe(true));
      expect(calls).toBe(3);
      expect(additionalOutcome?.error).toBeInstanceOf(ProviderUnavailableError);
      recovery.resolve();
      await probe;
      await call();
      expect(calls).toBe(4);
    } finally {
      old.resolve();
      recovery.resolve();
      await Promise.allSettled([first, probe, additional]);
      await sdk.close();
    }
  });
});

describe("remediation 14: one failure per logical provider call", () => {
  it("does not double-count a stream failure after a same-provider model failure", async () => {
    const error = Object.assign(new Error(), { status: 429 });
    let calls = 0;
    const create = async (_request: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) throw error;
      return (async function* () {
        yield { usage: { prompt_tokens: 0, completion_tokens: 1 } };
        throw error;
      })();
    };
    const policy = new HealthBasedPolicy();
    const states: string[] = [];
    const sdk = new Solwyn(
      { chat: { completions: { create } } },
      options({
        fallback: [[{ chat: { completions: { create } } }, "gpt-4o-mini"]],
        circuitBreakerFailureThreshold: 2,
        selectionPolicy: {
          order(candidates, request) {
            states.push(...candidates.map((candidate) => candidate.breakerState));
            return policy.order(candidates, request);
          },
        },
      }),
    );
    const consume = async () => {
      const source = await sdk.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        stream: true,
      });
      for await (const _event of source) {
        /* consume */
      }
    };
    try {
      await expect(consume()).rejects.toBe(error);
      expect(calls).toBe(2);
      states.length = 0;
      await expect(consume()).rejects.toBe(error);
      expect(states).toEqual(["closed", "closed"]);
      expect(calls).toBe(3);
    } finally {
      await sdk.close();
    }
  });
});

describe("remediation 15: hostile error inspection", () => {
  it.each([
    "name",
    "constructor",
    "status",
    "statusCode",
    "code",
    "cause",
    "errors",
  ])("does not propagate a throwing %s accessor", (property) => {
    const decorated = Object.defineProperty({}, property, {
      get() {
        throw new Error();
      },
    });
    const hostile =
      property === "errors"
        ? Object.assign(new Error(), { name: "APIConnectionError", cause: decorated })
        : property === "constructor"
          ? Object.create(decorated)
          : Object.assign(decorated, property === "name" ? {} : { name: "APIConnectionError" });
    expect(() => classifyException(hostile)).not.toThrow();
    expect(classifyException(hostile)).toBe(Disposition.FAIL_FAST);
    expect(() => retryAfterSeconds(hostile)).not.toThrow();
  });

  it("contains hostile prototype traps while preserving conservative classification", () => {
    const error = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error();
        },
      },
    );
    expect(classifyException(error)).toBe(Disposition.FAIL_FAST);
    expect(retryAfterSeconds(error)).toBeNull();
  });

  it("preserves the original thrown value and releases its recovery probe", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const hostile = Object.defineProperty({}, "name", {
      get() {
        throw new Error();
      },
    });
    let calls = 0;
    const create = async (_request: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error(), { status: 429 });
      throw hostile;
    };
    const sdk = new Solwyn(
      { chat: { completions: { create } } },
      options({ circuitBreakerFailureThreshold: 1, circuitBreakerRecoveryTimeout: 1 }),
    );
    const call = () => sdk.chat.completions.create({ model: "gpt-4o", messages: [] });
    try {
      await expect(call()).rejects.toMatchObject({ status: 429 });
      now = 1_000;
      expect(
        await call().then(
          () => false,
          (error) => error === hostile,
        ),
      ).toBe(true);
      now = 1_000_000;
      expect(
        await call().then(
          () => false,
          (error) => error === hostile,
        ),
      ).toBe(true);
      expect(calls).toBe(3);
    } finally {
      await sdk.close();
    }
  });
});
