import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError, SolwynError } from "../../src/errors";
import { SolwynRunScopeHandler } from "../../src/langchain/index";
import { createRun } from "../../src/node";
import {
  getCurrentRun,
  getDetachedRunFactory,
  resetDetachedRunFactory,
  setDetachedRunFactory,
} from "../../src/run-context";
import { brandSolwynWrapper } from "../../src/wrapper-brand";

const installedFactory = getDetachedRunFactory();
if (!installedFactory) throw new Error("Node entry did not install the detached-run factory");
const factory = installedFactory;
afterEach(() => setDetachedRunFactory(factory));
function start(
  handler: SolwynRunScopeHandler,
  id = "root",
  parent?: string,
  node?: string,
  name = "workflow",
) {
  handler.handleChainStart(
    undefined,
    undefined,
    id,
    parent,
    undefined,
    { langgraph_node: node },
    undefined,
    name,
  );
}
function bind(handler: SolwynRunScopeHandler, id = "model", parent = "root", signal?: AbortSignal) {
  handler.handleChatModelStart(undefined, undefined, id, parent);
  return handler.bindModelCall({ signal }, { runId: id, handlers: [handler] });
}
function leaf(
  handler: SolwynRunScopeHandler,
  create: (...args: unknown[]) => unknown = () => getCurrentRun(),
) {
  const client = { chat: { completions: { create } } };
  brandSolwynWrapper(client);
  return handler.chatCompletionsLeaf(client) as typeof client;
}
function counts(handler: SolwynRunScopeHandler) {
  return ["runs", "models", "roots"].map(
    (key) => (Reflect.get(handler, key) as Map<unknown, unknown>).size,
  );
}

describe("LangChain structural run handler", () => {
  it("requires Node attribution and a branded client", () => {
    resetDetachedRunFactory();
    expect(() => new SolwynRunScopeHandler()).toThrow(ConfigurationError);
    setDetachedRunFactory(factory);
    const handler = new SolwynRunScopeHandler();
    expect(() => handler.chatCompletionsLeaf({})).toThrow(ConfigurationError);
    expect(handler.copy()).toBe(handler);
    expect(handler).toMatchObject({
      awaitHandlers: true,
      raiseError: true,
      ignoreRetriever: false,
    });
  });
  it("validates options eagerly", () => {
    expect(() => new SolwynRunScopeHandler({ namePrefix: "" })).toThrow(ConfigurationError);
    expect(() => new SolwynRunScopeHandler({ tags: { bad: 3 } } as never)).toThrow(SolwynError);
  });
  it("fails closed on duplicate and missing hierarchy", () => {
    const handler = new SolwynRunScopeHandler();
    start(handler);
    expect(() => start(handler)).toThrow(SolwynError);
    expect(() => start(handler, "child", "unknown")).toThrow(SolwynError);
    expect(() => handler.handleChatModelStart(undefined, undefined, "m")).toThrow(SolwynError);
    expect(() => handler.handleLLMStart(undefined, undefined, "m", "unknown")).toThrow(SolwynError);
    handler.handleChainEnd(undefined, "root");
    expect(counts(handler)).toEqual([0, 0, 0]);
  });
  it("creates handles lazily, reuses node scopes, and keeps nested scopes distinct", async () => {
    const make = vi.fn(factory);
    setDetachedRunFactory(make);
    const handler = new SolwynRunScopeHandler({ tags: { suite: "synthetic" } });
    const client = leaf(handler);
    start(handler);
    start(handler, "prompt", "root");
    expect(make).not.toHaveBeenCalled();
    start(handler, "node-1", "root", "agent");
    const a = (await client.chat.completions.create(
      {},
      bind(handler, "m1", "node-1"),
    )) as ReturnType<typeof getCurrentRun>;
    handler.handleLLMEnd(undefined, "m1");
    handler.handleChainEnd(undefined, "node-1");
    start(handler, "node-2", "root", "agent");
    const b = (await client.chat.completions.create(
      {},
      bind(handler, "m2", "node-2"),
    )) as ReturnType<typeof getCurrentRun>;
    handler.handleLLMEnd(undefined, "m2");
    start(handler, "nested", "node-2", "inner");
    const c = (await client.chat.completions.create(
      {},
      bind(handler, "m3", "nested"),
    )) as ReturnType<typeof getCurrentRun>;
    handler.handleLLMEnd(undefined, "m3");
    expect(a?.agentRunId).toBe(b?.agentRunId);
    expect(c?.parentAgentRunId).toBe(a?.agentRunId);
    expect(a?.tags).toEqual({ suite: "synthetic" });
    expect(make).toHaveBeenCalledTimes(3);
    handler.handleChainEnd(undefined, "root");
    expect(counts(handler)).toEqual([0, 0, 0]);
  });
  it("maps tools and retrievers as transparent structural edges", async () => {
    const handler = new SolwynRunScopeHandler();
    start(handler);
    handler.handleToolStart(undefined, undefined, "tool", "root");
    handler.handleRetrieverStart(undefined, undefined, "retriever", "tool");
    start(handler, "chain", "retriever");
    const value = (await leaf(handler).chat.completions.create(
      {},
      bind(handler, "m", "chain"),
    )) as ReturnType<typeof getCurrentRun>;
    expect(value?.agentRunName).toBe("langchain:workflow");
    handler.handleLLMEnd(undefined, "m");
    handler.handleChainEnd(undefined, "chain");
    handler.handleRetrieverEnd(undefined, "retriever");
    handler.handleToolEnd(undefined, "tool");
    handler.handleChainEnd(undefined, "root");
    expect(counts(handler)).toEqual([0, 0, 0]);
  });
  it("requires the matching handler and per-call signal key", async () => {
    const handler = new SolwynRunScopeHandler();
    start(handler);
    handler.handleChatModelStart(undefined, undefined, "m", "root");
    for (const manager of [
      undefined,
      {},
      { runId: "m", handlers: [] },
      { runId: "missing", handlers: [handler] },
    ]) {
      expect(() => handler.bindModelCall({}, manager)).toThrow(SolwynError);
    }
    const client = leaf(handler);
    for (const options of [{}, { signal: new AbortController().signal }]) {
      expect(() => client.chat.completions.create({}, options)).toThrow(SolwynError);
    }
    handler.bindModelCall({}, { runId: "m", handlers: [handler] });
    handler.handleLLMError(undefined, "m");
    handler.handleChainError(undefined, "root");
    expect(counts(handler)).toEqual([0, 0, 0]);
  });
  it("links abort reasons, removes listeners, and invalidates finished model keys", async () => {
    const handler = new SolwynRunScopeHandler();
    start(handler);
    const upstream = new AbortController();
    const remove = vi.spyOn(upstream.signal, "removeEventListener");
    const options = bind(handler, "m", "root", upstream.signal);
    upstream.abort("synthetic cancellation");
    expect(options.signal?.aborted).toBe(true);
    expect(options.signal?.reason).toBe("synthetic cancellation");
    handler.handleLLMEnd(undefined, "m");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(() => leaf(handler).chat.completions.create({}, options)).toThrow(SolwynError);
    const pre = new AbortController();
    pre.abort("already cancelled");
    const earlier = bind(handler, "m2", "root", pre.signal);
    expect(earlier.signal?.reason).toBe("already cancelled");
    handler.handleLLMError(undefined, "m2");
    handler.handleChainEnd(undefined, "root");
  });
  it.each([
    "handleLLMEnd",
    "handleLLMError",
  ] as const)("%s cleans up and rejects an unbound model", (method) => {
    const handler = new SolwynRunScopeHandler();
    start(handler);
    handler.handleChatModelStart(undefined, undefined, "m", "root");
    expect(() => handler[method](undefined, "m")).toThrow(/not metered/);
    handler.handleChainError(undefined, "root");
    expect(counts(handler)).toEqual([0, 0, 0]);
  });
  it("finishes deferred scopes after an activation without masking its rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reject!: (reason: unknown) => void;
    const pending = new Promise((_, fail) => {
      reject = fail;
    });
    const handler = new SolwynRunScopeHandler();
    start(handler);
    const result = leaf(handler, () => pending).chat.completions.create({}, bind(handler));
    handler.handleChainEnd(undefined, "root");
    expect(counts(handler)[2]).toBe(1);
    const failure = new SolwynError("synthetic denial");
    reject(failure);
    await expect(result).rejects.toBe(failure);
    expect(Reflect.get(failure, Symbol.for("langchain.errors.retryable"))).toBe(false);
    handler.handleLLMError(undefined, "model");
    expect(counts(handler)).toEqual([0, 0, 0]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("stamps synchronous errors and refuses every other leaf member", () => {
    const handler = new SolwynRunScopeHandler();
    start(handler);
    const fail = new SolwynError("synthetic");
    const client = leaf(handler, () => {
      throw fail;
    });
    expect(() => client.chat.completions.create({}, bind(handler))).toThrow(fail);
    expect(Reflect.get(fail, Symbol.for("langchain.errors.retryable"))).toBe(false);
    for (const path of [
      () => Reflect.get(client, "responses"),
      () => Reflect.get(client.chat.completions, "parse"),
      () => Reflect.get(client.chat, "other"),
    ]) {
      try {
        path();
        throw new Error("expected refusal");
      } catch (failure) {
        expect(failure).toBeInstanceOf(SolwynError);
        expect(Reflect.get(failure as object, Symbol.for("langchain.errors.retryable"))).toBe(
          false,
        );
      }
    }
    handler.handleLLMError(undefined, "model");
    handler.handleChainError(undefined, "root");
  });
  it("sanitizes by code point and nests under an outer user run", async () => {
    const outer = createRun("outer");
    const handler = new SolwynRunScopeHandler();
    await outer.activate(async () => {
      start(handler, "root", undefined, undefined, `\n\ud800${"😀".repeat(300)}`);
      const value = (await leaf(handler).chat.completions.create({}, bind(handler))) as NonNullable<
        ReturnType<typeof getCurrentRun>
      >;
      expect(value.agentRunName.length).toBeLessThanOrEqual(255);
      expect([...value.agentRunName].length).toBeLessThanOrEqual(255);
      expect(value.agentRunName).not.toMatch(/[\p{Cc}\p{Cs}]/u);
      expect(value.parentAgentRunId).toBe(outer.runId);
      handler.handleLLMEnd(undefined, "model");
      handler.handleChainEnd(undefined, "root");
    });
    outer.finish();
  });
});
