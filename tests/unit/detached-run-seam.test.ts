import { beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError, SolwynError } from "../../src/errors";
import { requireDetachedRunFactory, requireSolwynClient } from "../../src/integration-support";
import {
  type DetachedRunFactory,
  getCurrentRun,
  getDetachedRunFactory,
  resetDetachedRunFactory,
  setDetachedRunFactory,
} from "../../src/run-context";
import { FakeControlPlane } from "../../src/testing";

let node: typeof import("../../src/node");
let factory: DetachedRunFactory;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  resetDetachedRunFactory();
  expect(getDetachedRunFactory()).toBeUndefined();
  node = await import("../../src/node");
  factory = requireDetachedRunFactory("test integration");
});

describe("internal detached-run seam", () => {
  it("installs a shared factory when the node entry is imported", () => {
    expect(getDetachedRunFactory()).toBe(factory);
    expect(Reflect.get(globalThis, Symbol.for("@solwyn/sdk.node.detachedRunFactory.v1"))).toBe(
      factory,
    );
    expect(node).not.toHaveProperty("getDetachedRunFactory");
    expect(node).not.toHaveProperty("requireDetachedRunFactory");
    expect(node.RunHandle.prototype).not.toHaveProperty("tryFinish");
  });

  it("returns undefined while absent and explains how to enable attribution", () => {
    resetDetachedRunFactory();
    try {
      expect(getDetachedRunFactory()).toBeUndefined();
      let caught: unknown;
      try {
        requireDetachedRunFactory("test integration");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect(caught).toMatchObject({ field: null });
      expect((caught as Error).message).toContain("@solwyn/sdk/node");
      expect((caught as Error).message).toMatch(/edge runtimes.*unsupported/i);
      expect((caught as Error).message).toContain("wrapped client alone still enforces budgets");
    } finally {
      setDetachedRunFactory(factory);
    }
    expect(requireDetachedRunFactory("test integration")).toBe(factory);
  });

  it("captures the caller's parent and explicit tags without entering a scope", () => {
    const tags = { component: "worker", shared: "child" };
    const { detached, parent } = node.run(
      "outer",
      { tags: { workflow: "synthetic", shared: "parent" } },
      () => {
        const parent = node.currentRunContext();
        const detached = factory("integration:worker", { tags });
        expect(node.currentRunContext()).toEqual(parent);
        return { detached, parent };
      },
    );
    tags.component = "changed";
    expect(detached.activate(() => node.currentRunContext())).toEqual({
      agentRunId: detached.runId,
      agentRunName: "integration:worker",
      parentAgentRunId: parent.agentRunId,
      tags: { component: "worker", shared: "child", workflow: "synthetic" },
    });
    expect(detached.activate(() => getCurrentRun()?.lifetime)).toBeTypeOf("object");
    expect(detached.tryFinish()).toBe(true);
    expect(getCurrentRun()).toBeUndefined();
  });

  it("parents under an active detached handle and inherits its tags", () => {
    const parent = node.createRun("parent", { tags: { component: "parent" } });
    const detached = parent.activate(() => factory("child"));
    const unrelated = node.createRun("unrelated");
    unrelated.activate(() => {
      expect(detached.activate(() => node.currentRunContext())).toMatchObject({
        parentAgentRunId: parent.runId,
        tags: { component: "parent" },
      });
      expect(node.currentRunContext().agentRunId).toBe(unrelated.runId);
    });
    expect(detached.tryFinish()).toBe(true);
    unrelated.finish();
    parent.finish();
  });

  it.each([
    "",
    " ",
    "bad\nname",
    "x".repeat(256),
  ])("reuses createRun name validation for %j", (name) => {
    expect(() => factory(name)).toThrow(SolwynError);
  });

  it("reuses createRun tag validation", () => {
    expect(() => factory("tags", { tags: { "": "invalid" } })).toThrow(SolwynError);
  });

  it("keeps the recursion guard and refuses to finish an active sync activation", () => {
    const detached = factory("recursive");
    const result = detached.activate(() => {
      expect(detached.tryFinish()).toBe(false);
      expect(() => detached.activate(() => undefined)).toThrow(/already active/);
      return 42;
    });
    expect(result).toBe(42);
    expect(detached.tryFinish()).toBe(true);
    expect(detached.tryFinish()).toBe(true);
    expect(() => detached.activate(() => undefined)).toThrow(/already finished/);
  });

  it("waits for every async activation and preserves the returned promise", async () => {
    const detached = factory("concurrent");
    const first = deferred();
    const second = deferred();
    const activeFirst = detached.activate(() => first.promise);
    const activeSecond = detached.activate(async () => {
      expect(detached.tryFinish()).toBe(false);
      await second.promise;
      expect(node.currentRunContext().agentRunId).toBe(detached.runId);
      expect(detached.tryFinish()).toBe(false);
    });
    expect(activeFirst).toBe(first.promise);
    expect(detached.tryFinish()).toBe(false);
    first.resolve();
    await activeFirst;
    expect(detached.tryFinish()).toBe(false);
    second.resolve();
    await activeSecond;
    expect(detached.tryFinish()).toBe(true);
    expect(detached.tryFinish()).toBe(true);
  });

  it("can finish after thrown and rejected activations without hiding their errors", async () => {
    const detached = factory("errors");
    const error = new SolwynError("synthetic failure");
    expect(() =>
      detached.activate(() => {
        throw error;
      }),
    ).toThrow(error);
    await expect(
      detached.activate(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(detached.tryFinish()).toBe(true);
  });
});

describe("integration wrapped-client guard", () => {
  it("accepts a real Solwyn wrapper and preserves its existing identity checks", async () => {
    const raw = { chat: { completions: { create: async () => ({}) } } };
    const wrapped = new FakeControlPlane().wrap(raw);
    try {
      expect(() => requireSolwynClient(wrapped, "test integration")).not.toThrow();
      expect(wrapped).toBeInstanceOf(node.Solwyn);
      expect(() => new node.Solwyn(wrapped, { apiKey: "unused" })).toThrow(ConfigurationError);
      expect(() =>
        requireSolwynClient(Object.create(Object.getPrototypeOf(wrapped)), "test"),
      ).toThrow(ConfigurationError);
      expect(() => requireSolwynClient(new Proxy(wrapped, {}), "test")).toThrow(ConfigurationError);
    } finally {
      await wrapped.close();
    }
  });

  it.each([
    null,
    undefined,
    {},
    { chat: { completions: { create() {} } } },
    () => undefined,
  ])("rejects a raw or lookalike client %j", (value) => {
    let caught: unknown;
    try {
      requireSolwynClient(value, "test integration");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({ field: "client" });
  });
});
