import { describe, expect, expectTypeOf, it, vi } from "vitest";
import * as rootApi from "../../src/index";
import * as nodeApi from "../../src/node";
import {
  acquireTerminationHandle,
  clearRunTermination,
  markTerminated,
  resetRunControlForTest,
  runTermination,
} from "../../src/run-control";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

interface WireCapture {
  readonly fetch: ReturnType<typeof vi.fn<FetchLike>>;
  readonly checks: Array<Record<string, unknown>>;
  readonly confirms: Array<Record<string, unknown>>;
  readonly events: Array<Record<string, unknown>>;
}

function makeWireCapture(reservationId: string | null = null): WireCapture {
  const checks: Array<Record<string, unknown>> = [];
  const confirms: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      checks.push(body as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 100,
          reservation_id: reservationId,
          mode: "alert_only",
          budget_limit: 100,
          current_usage: 0,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      confirms.push(body as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest")) {
      const batch = body as Array<Record<string, unknown>>;
      events.push(...batch);
      return new Response(JSON.stringify({ ingested: batch.length, rejected: [] }), {
        status: 202,
      });
    }
    throw new Error(`unexpected test URL: ${url}`);
  });
  return { fetch, checks, confirms, events };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("detached run handles", () => {
  it("exports createRun and RunHandle only from the node entry", () => {
    expect(nodeApi.createRun).toBeTypeOf("function");
    expect(nodeApi.RunHandle).toBeTypeOf("function");
    expect(nodeApi.RunHandle).not.toHaveProperty("create");

    const handle = nodeApi.createRun("detached");
    expect(handle).toBeInstanceOf(nodeApi.RunHandle);
    expect(rootApi).not.toHaveProperty("createRun");
    expect(rootApi).not.toHaveProperty("RunHandle");

    expectTypeOf(handle.runId).toEqualTypeOf<string>();
    expectTypeOf(handle.activate(() => 1)).toEqualTypeOf<number>();
    expectTypeOf(handle.finish()).toEqualTypeOf<void>();
  });

  it("snapshots identity without changing the current context", () => {
    const ownTags = { own: "original", shared: "own" };
    let handle: nodeApi.RunHandle | undefined;
    let creationParentId: string | null = null;

    nodeApi.run("creation-parent", { tags: { inherited: "parent", shared: "parent" } }, () => {
      const outer = nodeApi.currentRunContext();
      creationParentId = outer.agentRunId;
      handle = nodeApi.createRun("detached", { tags: ownTags });
      expect(nodeApi.currentRunContext()).toEqual(outer);
      ownTags.own = "mutated";
      ownTags.shared = "mutated";
    });

    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    const first = handle.activate(() => nodeApi.currentRunContext());
    expect(first).toEqual({
      agentRunId: handle.runId,
      agentRunName: "detached",
      tags: { own: "original", shared: "own", inherited: "parent" },
      parentAgentRunId: creationParentId,
    });

    if (first.tags !== null) first.tags["own"] = "mutated-snapshot";
    const second = handle.activate(() => nodeApi.currentRunContext());
    expect(second).toEqual({
      agentRunId: handle.runId,
      agentRunName: "detached",
      tags: { own: "original", shared: "own", inherited: "parent" },
      parentAgentRunId: creationParentId,
    });
    expect(second.tags).not.toBe(first.tags);

    const other = nodeApi.createRun("detached");
    expect(other.runId).not.toBe(handle.runId);
  });

  it("preserves creation parent and tags under an unrelated activation scope", () => {
    let handle: nodeApi.RunHandle | undefined;
    let creationParentId: string | null = null;
    nodeApi.run("parent-p", { tags: { origin: "p" } }, () => {
      creationParentId = nodeApi.currentRunContext().agentRunId;
      handle = nodeApi.createRun("detached-a", { tags: { own: "a" } });
    });

    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    const detached = handle;
    nodeApi.run("activation-q", { tags: { site: "q" } }, () => {
      const activationSite = nodeApi.currentRunContext();
      const activated = detached.activate(() => nodeApi.currentRunContext());
      expect(activated).toEqual({
        agentRunId: detached.runId,
        agentRunName: "detached-a",
        tags: { own: "a", origin: "p" },
        parentAgentRunId: creationParentId,
      });
      expect(activated.agentRunId).not.toBe(activationSite.agentRunId);
      expect(activated.tags).not.toHaveProperty("site");
      expect(nodeApi.currentRunContext()).toEqual(activationSite);
    });
  });

  it("can skip inherited tags without dropping the creation parent", () => {
    let handle: nodeApi.RunHandle | undefined;
    let creationParentId: string | null = null;
    nodeApi.run("parent", { tags: { inherited: "excluded" } }, () => {
      creationParentId = nodeApi.currentRunContext().agentRunId;
      handle = nodeApi.createRun("detached", {
        tags: { own: "kept" },
        inheritTags: false,
      });
    });

    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    expect(handle.activate(() => nodeApi.currentRunContext())).toEqual({
      agentRunId: handle.runId,
      agentRunName: "detached",
      tags: { own: "kept" },
      parentAgentRunId: creationParentId,
    });
  });

  it("returns exact synchronous values and releases after synchronous throws", () => {
    const handle = nodeApi.createRun("detached");
    const sentinel = { value: "same-object" };
    const thrown = new Error("callback failed");

    nodeApi.run("activation-site", () => {
      const site = nodeApi.currentRunContext();
      expect(handle.activate(() => sentinel)).toBe(sentinel);
      expect(nodeApi.currentRunContext()).toEqual(site);

      let caught: unknown;
      try {
        handle.activate(() => {
          throw thrown;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(thrown);
      expect(nodeApi.currentRunContext()).toEqual(site);
      expect(handle.activate(() => nodeApi.currentRun()?.agentRunId)).toBe(handle.runId);
      expect(nodeApi.currentRunContext()).toEqual(site);
    });
    expect(() => handle.finish()).not.toThrow();
  });

  it("finish while synchronously active is retryable", () => {
    const handle = nodeApi.createRun("detached");

    handle.activate(() => {
      let caught: unknown;
      try {
        handle.finish();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(rootApi.SolwynError);
      expect((caught as Error).message).toBe(
        `run handle '${handle.runId}' cannot finish while activations are still active`,
      );
      expect(nodeApi.currentRun()?.agentRunId).toBe(handle.runId);
    });

    expect(() => handle.finish()).not.toThrow();
  });

  it("finish tombstones activation and rejects double finish", () => {
    const handle = nodeApi.createRun("detached");
    const callback = vi.fn();
    handle.finish();

    let activationError: unknown;
    try {
      handle.activate(callback);
    } catch (error) {
      activationError = error;
    }
    expect(activationError).toBeInstanceOf(rootApi.SolwynError);
    expect((activationError as Error).message).toBe(
      `run handle '${handle.runId}' already finished`,
    );
    expect(callback).not.toHaveBeenCalled();

    let finishError: unknown;
    try {
      handle.finish();
    } catch (error) {
      finishError = error;
    }
    expect(finishError).toBeInstanceOf(rootApi.SolwynError);
    expect((finishError as Error).message).toBe(`run handle '${handle.runId}' already finished`);
  });

  it("protects detached identity and lifecycle state from reflective writes", () => {
    let handle: nodeApi.RunHandle | undefined;
    let creationParentId: string | null = null;
    nodeApi.run("immutable-parent", { tags: { inherited: "captured" } }, () => {
      creationParentId = nodeApi.currentRunContext().agentRunId;
      handle = nodeApi.createRun("immutable-handle", { tags: { own: "captured" } });
    });

    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    const detached = handle;
    const originalRunId = detached.runId;
    const forgedRunId = "run_forged";
    const unsafeHandle = detached as unknown as Record<string, unknown>;
    const forgedIdentity = {
      runId: forgedRunId,
      name: "forged-handle",
      tags: { forged: "forged" },
      parentRunId: "run_forged-parent",
    };

    Reflect.set(unsafeHandle, "runId", forgedRunId);
    Reflect.deleteProperty(unsafeHandle, "runId");
    Reflect.defineProperty(unsafeHandle, "runId", {
      configurable: true,
      enumerable: true,
      value: forgedRunId,
      writable: true,
    });
    Reflect.set(unsafeHandle, "identity", forgedIdentity);

    let observedContext: nodeApi.RunContext | undefined;
    let settle!: () => void;
    const pendingThenable = {
      // biome-ignore lint/suspicious/noThenProperty: Controlled settlement proves lifecycle state cannot be overwritten.
      then(onFulfilled: () => void) {
        settle = onFulfilled;
      },
    };
    const result = detached.activate(() => {
      observedContext = nodeApi.currentRunContext();
      return pendingThenable;
    });

    Reflect.set(unsafeHandle, "activeActivations", 0);
    Reflect.set(unsafeHandle, "finished", false);
    let activeFinishError: unknown;
    try {
      detached.finish();
    } catch (error) {
      activeFinishError = error;
    }

    let settlementError: unknown;
    try {
      settle();
    } catch (error) {
      settlementError = error;
    }

    let settledFinishError: unknown;
    try {
      detached.finish();
    } catch (error) {
      settledFinishError = error;
    }

    Reflect.set(unsafeHandle, "finished", false);
    Reflect.set(unsafeHandle, "identity", forgedIdentity);
    Reflect.set(unsafeHandle, "runId", forgedRunId);
    const callbackAfterFinish = vi.fn();
    let activationAfterFinishError: unknown;
    try {
      detached.activate(callbackAfterFinish);
    } catch (error) {
      activationAfterFinishError = error;
    }
    let repeatedFinishError: unknown;
    try {
      detached.finish();
    } catch (error) {
      repeatedFinishError = error;
    }

    expect(result).toBe(pendingThenable);
    expect(detached.runId).toBe(originalRunId);
    expect(observedContext).toEqual({
      agentRunId: originalRunId,
      agentRunName: "immutable-handle",
      tags: { own: "captured", inherited: "captured" },
      parentAgentRunId: creationParentId,
    });
    expect(activeFinishError).toBeInstanceOf(rootApi.SolwynError);
    expect((activeFinishError as Error).message).toBe(
      `run handle '${originalRunId}' cannot finish while activations are still active`,
    );
    expect(settlementError).toBeUndefined();
    expect(settledFinishError).toBeUndefined();
    expect(activationAfterFinishError).toBeInstanceOf(rootApi.SolwynError);
    expect((activationAfterFinishError as Error).message).toBe(
      `run handle '${originalRunId}' already finished`,
    );
    expect(callbackAfterFinish).not.toHaveBeenCalled();
    expect(repeatedFinishError).toBeInstanceOf(rootApi.SolwynError);
    expect((repeatedFinishError as Error).message).toBe(
      `run handle '${originalRunId}' already finished`,
    );
  });

  it("validates detached run definitions without changing context or exposing tag data", () => {
    const throwingTags = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("sensitive-proxy-tag=value\nforged");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const symbolTags: Record<PropertyKey, unknown> = { visible: "sensitive-symbol-value" };
    symbolTags[Symbol("sensitive-symbol-key")] = "hidden";
    const longName = `sensitive-name-${"n".repeat(241)}`;
    const longKey = `sensitive-key-${"k".repeat(65)}`;
    const longValue = `sensitive-value-${"v".repeat(257)}`;

    const invalidCases: Array<{
      readonly label: string;
      readonly name: unknown;
      readonly options: unknown;
      readonly message: string;
      readonly secrets?: readonly string[];
    }> = [
      {
        label: "non-string name",
        name: 7,
        options: { tags: { private: "sensitive-name-tag" } },
        message: "run name requires a string",
        secrets: ["sensitive-name-tag"],
      },
      {
        label: "blank name",
        name: "   ",
        options: { tags: { private: "sensitive-blank-tag" } },
        message: "run name must be non-empty",
        secrets: ["sensitive-blank-tag"],
      },
      {
        label: "oversized name",
        name: longName,
        options: { tags: { private: "sensitive-long-name-tag" } },
        message: "run name exceeds the max length of 255",
        secrets: [longName, "sensitive-long-name-tag"],
      },
      {
        label: "disallowed name",
        name: "sensitive\nname",
        options: { tags: { private: "sensitive-control-name-tag" } },
        message: "run name must not contain control characters",
        secrets: ["sensitive", "sensitive-control-name-tag"],
      },
      {
        label: "null options",
        name: "valid",
        options: null,
        message: "createRun requires an options object",
      },
      {
        label: "array options",
        name: "valid",
        options: [],
        message: "createRun requires an options object",
      },
      {
        label: "primitive options",
        name: "valid",
        options: 42,
        message: "createRun requires an options object",
      },
      {
        label: "non-boolean inheritTags",
        name: "valid",
        options: { inheritTags: "sensitive-inherit" },
        message: "solwyn.run(inheritTags) requires a boolean",
        secrets: ["sensitive-inherit"],
      },
      {
        label: "non-record tags",
        name: "valid",
        options: { tags: [] },
        message: "solwyn.run(tags) requires a plain record of string keys to string values",
      },
      {
        label: "throwing tag proxy",
        name: "valid",
        options: { tags: throwingTags },
        message: "solwyn.run(tags) requires a plain record of string keys to string values",
        secrets: ["sensitive-proxy-tag", "forged"],
      },
      {
        label: "revoked tag proxy",
        name: "valid",
        options: { tags: revoked.proxy },
        message: "solwyn.run(tags) requires a plain record of string keys to string values",
      },
      {
        label: "symbol tag key",
        name: "valid",
        options: { tags: symbolTags },
        message: "solwyn.run(tags) keys must be strings",
        secrets: ["sensitive-symbol-key", "sensitive-symbol-value"],
      },
      {
        label: "too many tag keys",
        name: "valid",
        options: {
          tags: Object.fromEntries(
            Array.from({ length: 11 }, (_, index) => [`sensitive-over-${index}`, "private"]),
          ),
        },
        message: "solwyn.run(tags) allows at most 10 keys",
        secrets: ["sensitive-over-0", "private"],
      },
      {
        label: "empty tag key",
        name: "valid",
        options: { tags: { "": "sensitive-empty-key-value" } },
        message: "solwyn.run(tags) keys must be non-empty",
        secrets: ["sensitive-empty-key-value"],
      },
      {
        label: "NUL tag key",
        name: "valid",
        options: { tags: { "sensitive\0key": "private" } },
        message: "solwyn.run(tags) keys must not contain NUL characters",
        secrets: ["sensitive", "private"],
      },
      {
        label: "oversized tag key",
        name: "valid",
        options: { tags: { [longKey]: "private" } },
        message: "solwyn.run(tags) key exceeds max length 64",
        secrets: [longKey, "private"],
      },
      {
        label: "non-string tag value",
        name: "valid",
        options: { tags: { private: 7 } },
        message: "solwyn.run(tags) values must be strings",
        secrets: ["private"],
      },
      {
        label: "NUL tag value",
        name: "valid",
        options: { tags: { private: "sensitive\0value" } },
        message: "solwyn.run(tags) values must not contain NUL characters",
        secrets: ["private", "sensitive"],
      },
      {
        label: "oversized tag value",
        name: "valid",
        options: { tags: { private: longValue } },
        message: "solwyn.run(tags) value exceeds max length 256",
        secrets: ["private", longValue],
      },
    ];

    type UnsafeCreateRun = (name: unknown, options?: unknown) => nodeApi.RunHandle;
    const unsafeCreateRun = nodeApi.createRun as UnsafeCreateRun;
    let validHandle: nodeApi.RunHandle | undefined;
    let validationParentId: string | null = null;
    const boundaryKey = "🌿".repeat(64);
    const boundaryValue = "🌱".repeat(256);
    const validTags = {
      [boundaryKey]: boundaryValue,
      empty: "",
      ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`tag-${index}`, "value"])),
    };

    nodeApi.run("validation-parent", { tags: { outer: "unchanged" } }, () => {
      const outer = nodeApi.currentRunContext();
      validationParentId = outer.agentRunId;
      for (const invalidCase of invalidCases) {
        const callback = vi.fn();
        let caught: unknown;
        try {
          unsafeCreateRun(invalidCase.name, invalidCase.options).activate(callback);
        } catch (error) {
          caught = error;
        }

        expect(caught, invalidCase.label).toBeInstanceOf(rootApi.SolwynError);
        expect((caught as Error).message, invalidCase.label).toBe(invalidCase.message);
        for (const secret of invalidCase.secrets ?? []) {
          expect((caught as Error).message, invalidCase.label).not.toContain(secret);
        }
        expect(callback, invalidCase.label).not.toHaveBeenCalled();
        expect(nodeApi.currentRunContext(), invalidCase.label).toEqual(outer);
      }

      validHandle = nodeApi.createRun("v".repeat(255), {
        tags: validTags,
        inheritTags: false,
      });
      expect(nodeApi.currentRunContext()).toEqual(outer);
    });

    expect(validHandle).toBeDefined();
    if (validHandle === undefined) throw new Error("test setup failed");
    expect(validHandle.activate(() => nodeApi.currentRunContext())).toEqual({
      agentRunId: validHandle.runId,
      agentRunName: "v".repeat(255),
      tags: validTags,
      parentAgentRunId: validationParentId,
    });
  });

  it("keeps an activation live until the original promise settles", async () => {
    let resolveFirst!: (value: string) => void;
    const firstPromise = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const firstHandle = nodeApi.createRun("first");
    const firstResult = firstHandle.activate(() => firstPromise);
    expect(firstResult).toBe(firstPromise);
    expect(() => firstHandle.finish()).toThrow(
      `run handle '${firstHandle.runId}' cannot finish while activations are still active`,
    );

    resolveFirst("fulfilled");
    await expect(firstResult).resolves.toBe("fulfilled");
    expect(() => firstHandle.finish()).not.toThrow();

    let rejectSecond!: (reason: unknown) => void;
    const secondPromise = new Promise<never>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const rejection = new Error("same rejection");
    const secondHandle = nodeApi.createRun("second");
    const secondResult = secondHandle.activate(() => secondPromise);
    expect(secondResult).toBe(secondPromise);
    expect(() => secondHandle.finish()).toThrow(
      `run handle '${secondHandle.runId}' cannot finish while activations are still active`,
    );

    rejectSecond(rejection);
    await expect(secondResult).rejects.toBe(rejection);
    expect(() => secondHandle.finish()).not.toThrow();
  });

  it("allows one handle in concurrent independent async contexts", async () => {
    const handle = nodeApi.createRun("parallel", { tags: { task: "shared" } });
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const observations: nodeApi.RunContext[] = [];

    const first = handle.activate(async () => {
      observations.push(nodeApi.currentRunContext());
      firstEntered.resolve(undefined);
      await releaseFirst.promise;
      observations.push(nodeApi.currentRunContext());
      return "first";
    });
    expect(nodeApi.currentRunContext()).toEqual({
      agentRunId: null,
      agentRunName: null,
      tags: null,
      parentAgentRunId: null,
    });

    const second = handle.activate(async () => {
      observations.push(nodeApi.currentRunContext());
      secondEntered.resolve(undefined);
      await releaseSecond.promise;
      observations.push(nodeApi.currentRunContext());
      return "second";
    });
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    expect(nodeApi.currentRunContext()).toEqual({
      agentRunId: null,
      agentRunName: null,
      tags: null,
      parentAgentRunId: null,
    });
    expect(observations).toEqual([
      {
        agentRunId: handle.runId,
        agentRunName: "parallel",
        tags: { task: "shared" },
        parentAgentRunId: null,
      },
      {
        agentRunId: handle.runId,
        agentRunName: "parallel",
        tags: { task: "shared" },
        parentAgentRunId: null,
      },
    ]);

    releaseFirst.resolve(undefined);
    await expect(first).resolves.toBe("first");
    expect(() => handle.finish()).toThrow(
      `run handle '${handle.runId}' cannot finish while activations are still active`,
    );

    releaseSecond.resolve(undefined);
    await expect(second).resolves.toBe("second");
    expect(observations).toEqual([
      {
        agentRunId: handle.runId,
        agentRunName: "parallel",
        tags: { task: "shared" },
        parentAgentRunId: null,
      },
      {
        agentRunId: handle.runId,
        agentRunName: "parallel",
        tags: { task: "shared" },
        parentAgentRunId: null,
      },
      {
        agentRunId: handle.runId,
        agentRunName: "parallel",
        tags: { task: "shared" },
        parentAgentRunId: null,
      },
      {
        agentRunId: handle.runId,
        agentRunName: "parallel",
        tags: { task: "shared" },
        parentAgentRunId: null,
      },
    ]);
    expect(() => handle.finish()).not.toThrow();
  });

  it("rejects direct and indirect same-chain reactivation", () => {
    const first = nodeApi.createRun("first");
    const second = nodeApi.createRun("second");
    const indirectCallback = vi.fn();
    const directCallback = vi.fn();
    const outerResult = { exact: "outer" };

    expect(
      first.activate(() => {
        expect(nodeApi.currentRun()?.agentRunId).toBe(first.runId);
        expect(
          second.activate(() => {
            expect(nodeApi.currentRun()?.agentRunId).toBe(second.runId);
            let caught: unknown;
            try {
              first.activate(indirectCallback);
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(rootApi.SolwynError);
            expect((caught as Error).message).toBe(
              `run handle '${first.runId}' is already active in this context`,
            );
            expect(indirectCallback).not.toHaveBeenCalled();
            expect(nodeApi.currentRun()?.agentRunId).toBe(second.runId);
          }),
        ).toBeUndefined();
        expect(nodeApi.currentRun()?.agentRunId).toBe(first.runId);
        return outerResult;
      }),
    ).toBe(outerResult);
    expect(nodeApi.currentRun()).toBeUndefined();

    first.activate(() => {
      let caught: unknown;
      try {
        first.activate(directCallback);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(rootApi.SolwynError);
      expect((caught as Error).message).toBe(
        `run handle '${first.runId}' is already active in this context`,
      );
      expect(directCallback).not.toHaveBeenCalled();
      expect(nodeApi.currentRun()?.agentRunId).toBe(first.runId);
    });
    expect(nodeApi.currentRun()).toBeUndefined();

    first.finish();
    second.finish();
  });

  it("rejects activation in a child task that inherited the active frame", async () => {
    const handle = nodeApi.createRun("inherited-parent");
    const nestedCallback = vi.fn();

    const childTask = handle.activate(() =>
      Promise.resolve().then(() => {
        expect(nodeApi.currentRun()?.agentRunId).toBe(handle.runId);
        let caught: unknown;
        try {
          handle.activate(nestedCallback);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(rootApi.SolwynError);
        expect((caught as Error).message).toBe(
          `run handle '${handle.runId}' is already active in this context`,
        );
        expect(nestedCallback).not.toHaveBeenCalled();
        expect(nodeApi.currentRun()?.agentRunId).toBe(handle.runId);
      }),
    );

    expect(nodeApi.currentRun()).toBeUndefined();
    await childTask;
    expect(nodeApi.currentRun()).toBeUndefined();
    expect(() => handle.finish()).not.toThrow();
  });

  it("reuses one detached identity across sequential async tasks", async () => {
    const ownTags = { own: "captured" };
    let handle: nodeApi.RunHandle | undefined;
    let creationParentId: string | null = null;
    nodeApi.run("creation-parent", { tags: { inherited: "captured" } }, () => {
      creationParentId = nodeApi.currentRunContext().agentRunId;
      handle = nodeApi.createRun("reusable", { tags: ownTags });
      ownTags.own = "mutated";
    });

    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    const detached = handle;
    const observations: nodeApi.RunContext[] = [];
    for (const [siteName, siteTag] of [
      ["site-one", "one"],
      ["site-two", "two"],
    ] as const) {
      await nodeApi.run(siteName, { tags: { site: siteTag } }, async () => {
        const activationSite = nodeApi.currentRunContext();
        observations.push(
          await detached.activate(async () => {
            await Promise.resolve();
            return nodeApi.currentRunContext();
          }),
        );
        expect(nodeApi.currentRunContext()).toEqual(activationSite);
      });
    }

    expect(observations).toEqual([
      {
        agentRunId: detached.runId,
        agentRunName: "reusable",
        tags: { own: "captured", inherited: "captured" },
        parentAgentRunId: creationParentId,
      },
      {
        agentRunId: detached.runId,
        agentRunName: "reusable",
        tags: { own: "captured", inherited: "captured" },
        parentAgentRunId: creationParentId,
      },
    ]);
    expect(nodeApi.currentRun()).toBeUndefined();
    expect(() => detached.finish()).not.toThrow();
  });

  it("releases exactly once on synchronous throw, async rejection, and abort rejection", async () => {
    const handle = nodeApi.createRun("cleanup");
    const syncError = new Error("sync failure");
    const asyncError = new Error("async failure");
    const abortError = new Error("abort failure");
    const getterError = new Error("then getter failure");
    const registrationError = new Error("then registration failure");

    await nodeApi.run("outer", async () => {
      const outer = nodeApi.currentRunContext();

      let caughtSync: unknown;
      try {
        handle.activate(() => {
          throw syncError;
        });
      } catch (error) {
        caughtSync = error;
      }
      expect(caughtSync).toBe(syncError);
      expect(nodeApi.currentRunContext()).toEqual(outer);

      const rejectedPromise = Promise.reject(asyncError);
      const rejectedResult = handle.activate(() => rejectedPromise);
      expect(rejectedResult).toBe(rejectedPromise);
      await expect(rejectedResult).rejects.toBe(asyncError);
      expect(nodeApi.currentRunContext()).toEqual(outer);

      const abortController = new AbortController();
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortController.signal.addEventListener("abort", () => reject(abortError), { once: true });
      });
      const abortResult = handle.activate(() => abortPromise);
      expect(abortResult).toBe(abortPromise);
      abortController.abort();
      await expect(abortResult).rejects.toBe(abortError);
      expect(nodeApi.currentRunContext()).toEqual(outer);

      // biome-ignore lint/suspicious/noThenProperty: This deliberately hostile thenable tests accessor cleanup.
      const throwingGetter = Object.defineProperty({}, "then", {
        get() {
          throw getterError;
        },
      });
      let caughtGetter: unknown;
      try {
        handle.activate(() => throwingGetter);
      } catch (error) {
        caughtGetter = error;
      }
      expect(caughtGetter).toBe(getterError);
      expect(nodeApi.currentRunContext()).toEqual(outer);

      const throwingRegistration = {
        // biome-ignore lint/suspicious/noThenProperty: This deliberately hostile thenable tests registration cleanup.
        then() {
          throw registrationError;
        },
      };
      let caughtRegistration: unknown;
      try {
        handle.activate(() => throwingRegistration);
      } catch (error) {
        caughtRegistration = error;
      }
      expect(caughtRegistration).toBe(registrationError);
      expect(nodeApi.currentRunContext()).toEqual(outer);

      const doubleSettlingThenable = {
        // biome-ignore lint/suspicious/noThenProperty: This deliberately non-compliant thenable proves release is idempotent.
        then(onFulfilled: () => void, onRejected: () => void) {
          onFulfilled();
          onRejected();
        },
      };
      expect(handle.activate(() => doubleSettlingThenable)).toBe(doubleSettlingThenable);
      expect(nodeApi.currentRunContext()).toEqual(outer);

      const held = deferred<void>();
      const heldResult = handle.activate(() => held.promise);
      expect(() => handle.finish()).toThrow(
        `run handle '${handle.runId}' cannot finish while activations are still active`,
      );
      held.resolve(undefined);
      await heldResult;
      expect(nodeApi.currentRunContext()).toEqual(outer);
    });

    expect(nodeApi.currentRun()).toBeUndefined();
    expect(handle.activate(() => "reused")).toBe("reused");
    expect(() => handle.finish()).not.toThrow();
  });

  it("threads detached creation attribution through text budget and metadata", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const client = { chat: { completions: { create } } };
    const defaultTags = {
      configured: "client",
      inherited: "client",
      own: "client",
      shared: "client",
    };
    const defaultTagsBefore = { ...defaultTags };
    const callerTags = { call: "per-call", shared: "per-call" };
    const caller = { model: "gpt-4o", messages: [], solwyn_tags: callerTags };
    const creationParentTags = { inherited: "creation-parent", shared: "creation-parent" };
    const detachedTags = { own: "detached", shared: "detached" };
    const wire = makeWireCapture();
    const solwyn = new rootApi.Solwyn(client, {
      apiKey: API_KEY,
      fetch: wire.fetch,
      tags: defaultTags,
      leaseEnabled: false,
      velocityMode: "off",
      breakerReportingEnabled: false,
    });

    let creationParentId = "";
    let handle: nodeApi.RunHandle | undefined;
    nodeApi.run("creation-parent-p", { tags: creationParentTags }, () => {
      creationParentId = nodeApi.currentRunContext().agentRunId ?? "";
      handle = nodeApi.createRun("detached-text", { tags: detachedTags });
    });
    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    const detached = handle;
    creationParentTags.inherited = "mutated-parent";
    detachedTags.own = "mutated-detached";

    let activationSiteId = "";
    try {
      await nodeApi.run(
        "activation-site-q",
        { tags: { activation: "must-not-leak", shared: "activation" } },
        async () => {
          activationSiteId = nodeApi.currentRunContext().agentRunId ?? "";
          await detached.activate(() => solwyn.chat.completions.create(caller));
          expect(nodeApi.currentRunContext().agentRunId).toBe(activationSiteId);
        },
      );
    } finally {
      await solwyn.close();
    }

    const expectedTags = {
      call: "per-call",
      shared: "per-call",
      own: "detached",
      inherited: "creation-parent",
      configured: "client",
    };
    expect(wire.checks).toHaveLength(1);
    expect(wire.checks[0]).toMatchObject({
      agent_run_id: detached.runId,
      tags: expectedTags,
    });
    expect(wire.checks[0]).not.toHaveProperty("agent_run_name");
    expect(wire.checks[0]).not.toHaveProperty("parent_agent_run_id");
    expect(wire.checks[0]?.["agent_run_id"]).not.toBe(activationSiteId);
    expect(wire.checks[0]?.["tags"]).toEqual(expectedTags);

    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]).toMatchObject({
      agent_run_id: detached.runId,
      agent_run_name: "detached-text",
      parent_agent_run_id: creationParentId,
      tags: expectedTags,
    });
    expect(wire.events[0]?.["agent_run_id"]).not.toBe(activationSiteId);
    expect(wire.events[0]?.["tags"]).toEqual(expectedTags);
    expect(wire.confirms).toHaveLength(0);

    const providerKwargs = create.mock.calls[0]?.[0];
    expect(providerKwargs).toBeDefined();
    expect(providerKwargs).not.toHaveProperty("solwyn_tags");
    expect(caller).toEqual({ model: "gpt-4o", messages: [], solwyn_tags: callerTags });
    expect(caller.solwyn_tags).toBe(callerTags);
    expect(defaultTags).toEqual(defaultTagsBefore);
    expect(nodeApi.currentRun()).toBeUndefined();
  });

  it("threads detached creation attribution through media budget and metadata", async () => {
    const embeddingsCreate = vi.fn((_kwargs: Record<string, unknown>) => ({
      data: [{ embedding: [0.1] }],
      usage: { prompt_tokens: 42 },
    }));
    const client = {
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: embeddingsCreate },
    };
    const defaultTags = {
      configured: "client",
      inherited: "client",
      own: "client",
      shared: "client",
    };
    const defaultTagsBefore = { ...defaultTags };
    const callerTags = { media: "per-call", shared: "per-call" };
    const input = "x".repeat(40);
    const caller = { model: "text-embedding-3-small", input, solwyn_tags: callerTags };
    const creationParentTags = { inherited: "creation-parent", shared: "creation-parent" };
    const detachedTags = { own: "detached", shared: "detached" };
    const wire = makeWireCapture();
    const solwyn = new rootApi.Solwyn(client, {
      apiKey: API_KEY,
      fetch: wire.fetch,
      tags: defaultTags,
      leaseEnabled: false,
      velocityMode: "off",
      breakerReportingEnabled: false,
    });

    let creationParentId = "";
    let handle: nodeApi.RunHandle | undefined;
    nodeApi.run("media-creation-parent-p", { tags: creationParentTags }, () => {
      creationParentId = nodeApi.currentRunContext().agentRunId ?? "";
      handle = nodeApi.createRun("detached-media", { tags: detachedTags });
    });
    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    const detached = handle;
    creationParentTags.inherited = "mutated-parent";
    detachedTags.own = "mutated-detached";

    let activationSiteId = "";
    try {
      await nodeApi.run(
        "media-activation-site-q",
        { tags: { activation: "must-not-leak", shared: "activation" } },
        async () => {
          activationSiteId = nodeApi.currentRunContext().agentRunId ?? "";
          await detached.activate(() => solwyn.embeddings.create(caller));
          expect(nodeApi.currentRunContext().agentRunId).toBe(activationSiteId);
        },
      );
    } finally {
      await solwyn.close();
    }

    const expectedTags = {
      media: "per-call",
      shared: "per-call",
      own: "detached",
      inherited: "creation-parent",
      configured: "client",
    };
    expect(wire.checks).toHaveLength(1);
    expect(wire.checks[0]).toMatchObject({
      agent_run_id: detached.runId,
      tags: expectedTags,
      modality: "embedding",
      estimated_input_tokens: 10,
    });
    expect(wire.checks[0]).not.toHaveProperty("agent_run_name");
    expect(wire.checks[0]).not.toHaveProperty("parent_agent_run_id");
    expect(wire.checks[0]).not.toHaveProperty("estimated_media");
    expect(wire.checks[0]?.["agent_run_id"]).not.toBe(activationSiteId);
    expect(wire.checks[0]?.["tags"]).toEqual(expectedTags);

    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]).toMatchObject({
      status: "success",
      modality: "embedding",
      input_tokens: 42,
      output_tokens: 0,
      agent_run_id: detached.runId,
      agent_run_name: "detached-media",
      parent_agent_run_id: creationParentId,
      tags: expectedTags,
    });
    expect(wire.events[0]?.["agent_run_id"]).not.toBe(activationSiteId);
    expect(wire.events[0]?.["tags"]).toEqual(expectedTags);
    expect(wire.confirms).toHaveLength(0);

    const providerKwargs = embeddingsCreate.mock.calls[0]?.[0];
    expect(providerKwargs).toBeDefined();
    expect(providerKwargs).not.toHaveProperty("solwyn_tags");
    expect(caller).toEqual({ model: "text-embedding-3-small", input, solwyn_tags: callerTags });
    expect(caller.solwyn_tags).toBe(callerTags);
    expect(defaultTags).toEqual(defaultTagsBefore);
    expect(nodeApi.currentRun()).toBeUndefined();
  });

  it("keeps R1 watcher ownership independent from RunHandle finish", () => {
    resetRunControlForTest();
    const handle = nodeApi.createRun("r1-owner");
    let watcher: ReturnType<typeof acquireTerminationHandle> | undefined;

    try {
      watcher = handle.activate(() => acquireTerminationHandle(handle.runId));
      const winner = markTerminated(handle.runId, {
        reason: "before-handle-finish",
        source: "server",
      });
      expect(Object.isFrozen(winner)).toBe(true);
      expect(runTermination(handle.runId)).toBe(winner);
      expect(watcher.check()).toBe(winner);

      handle.finish();
      expect(runTermination(handle.runId)).toBe(winner);
      expect(watcher.check()).toBe(winner);

      const afterFinish = markTerminated(handle.runId, {
        reason: "after-handle-finish",
        source: "local_velocity",
      });
      expect(afterFinish).toBe(winner);
      expect(runTermination(handle.runId)).toBe(winner);
      expect(watcher.check()).toBe(winner);
    } finally {
      watcher?.release();
      clearRunTermination(handle.runId);
      resetRunControlForTest();
    }
  });

  it("lets issued streaming work outlive activation accounting", async () => {
    resetRunControlForTest();
    let providerPulls = 0;
    let providerCloses = 0;
    async function* rawStream(): AsyncGenerator<unknown> {
      try {
        providerPulls += 1;
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        };
        providerPulls += 1;
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 99, completion_tokens: 99 },
        };
      } finally {
        providerCloses += 1;
      }
    }
    const rawIterator = rawStream();
    const rawReturn = vi.spyOn(rawIterator, "return");
    const create = vi.fn((_kwargs: Record<string, unknown>) => rawIterator);
    const client = { chat: { completions: { create } } };
    const wire = makeWireCapture();
    const solwyn = new rootApi.Solwyn(client, {
      apiKey: API_KEY,
      fetch: wire.fetch,
      tags: { configured: "client", shared: "client" },
      leaseEnabled: false,
      velocityMode: "off",
      breakerReportingEnabled: false,
    });

    let creationParentId = "";
    let handle: nodeApi.RunHandle | undefined;
    nodeApi.run("stream-creation-parent", { tags: { inherited: "parent" } }, () => {
      creationParentId = nodeApi.currentRunContext().agentRunId ?? "";
      handle = nodeApi.createRun("detached-stream", {
        tags: { own: "detached", shared: "detached" },
      });
    });
    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("test setup failed");
    const detached = handle;
    let stream: AsyncIterableIterator<unknown> | undefined;

    try {
      const issued = nodeApi.run(
        "stream-activation-site",
        { tags: { activation: "must-not-leak", shared: "activation" } },
        () =>
          detached.activate(() =>
            solwyn.chat.completions.create({
              model: "gpt-4o",
              messages: [],
              stream: true,
              solwyn_tags: { call: "per-call", shared: "per-call" },
            }),
          ),
      );
      stream = (await issued) as AsyncIterableIterator<unknown>;
      expect(nodeApi.currentRun()).toBeUndefined();
      expect(providerPulls).toBe(0);
      expect(providerCloses).toBe(0);
      expect(rawReturn).not.toHaveBeenCalled();

      expect(() => detached.finish()).not.toThrow();
      const first = await stream.next();
      expect(first).toMatchObject({
        done: false,
        value: {
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        },
      });

      const winner = markTerminated(detached.runId, {
        reason: "stop-open-stream",
        source: "server",
      });
      const stopped = await stream.next().catch((error: unknown) => error);
      expect(stopped).toBeInstanceOf(rootApi.RunStoppedError);
      expect(stopped).toMatchObject({
        agentRunId: detached.runId,
        reason: winner.reason,
        source: winner.source,
      });
      expect(await stream.next().catch((error: unknown) => error)).toBe(stopped);
      expect(providerPulls).toBe(2);
      expect(rawReturn).toHaveBeenCalledOnce();
      expect(providerCloses).toBe(1);
    } finally {
      if (stream !== undefined) await stream.return?.();
      clearRunTermination(detached.runId);
      resetRunControlForTest();
      await solwyn.close();
    }

    expect(rawReturn).toHaveBeenCalledOnce();
    expect(providerCloses).toBe(1);
    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]).toMatchObject({
      status: "success",
      input_tokens: 3,
      output_tokens: 2,
      agent_run_id: detached.runId,
      agent_run_name: "detached-stream",
      parent_agent_run_id: creationParentId,
      tags: {
        call: "per-call",
        shared: "per-call",
        own: "detached",
        inherited: "parent",
        configured: "client",
      },
    });
    expect(wire.events[0]?.["tags"]).toEqual({
      call: "per-call",
      shared: "per-call",
      own: "detached",
      inherited: "parent",
      configured: "client",
    });
    const providerKwargs = create.mock.calls[0]?.[0];
    expect(providerKwargs).toBeDefined();
    expect(providerKwargs).not.toHaveProperty("solwyn_tags");
  });
});
