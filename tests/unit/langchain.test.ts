import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, RunStoppedError, SolwynError } from "../../src/errors";
import { SolwynRunScopeHandler } from "../../src/langchain/index";
import { run } from "../../src/node";
import { clearRunTermination, markTerminated } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing/index";
import { createFakeOpenAITransport } from "../helpers/fake-openai-transport";
import { installIntegrationEnv } from "../helpers/integration-env";
import { trackIntegrationRuns } from "../helpers/integration-runs";
import { recipeModel } from "../helpers/langchain-recipe";

const env = installIntegrationEnv();
let OpenAI: typeof import("openai").default;
let prompts: typeof import("@langchain/core/prompts");
let callbacks: typeof import("@langchain/core/callbacks/manager");
let graph: typeof import("@langchain/langgraph");
let LC: typeof import("@langchain/openai");
beforeAll(async () => {
  OpenAI = (await import("openai")).default;
  prompts = await import("@langchain/core/prompts");
  callbacks = await import("@langchain/core/callbacks/manager");
  graph = await import("@langchain/langgraph");
  LC = await import("@langchain/openai");
});
afterAll(() => env.restore());
const clients: Array<{ close(): Promise<void> }> = [];
let tracker: ReturnType<typeof trackIntegrationRuns>;
beforeEach(() => {
  tracker = trackIntegrationRuns();
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  tracker.restore();
  expect(tracker.active.size).toBe(0);
  for (const handle of tracker.handles)
    expect(() => handle.activate(() => undefined)).toThrow(/finished/);
  expect(env.fetchAttempts).toEqual([]);
  expect(env.socketAttempts()).toBe(0);
  vi.restoreAllMocks();
});
async function setup(
  options: Parameters<typeof FakeControlPlane.prototype.wrap>[1] = { leaseEnabled: false },
  fields: Record<string, unknown> = {},
  status: number | number[] = 200,
  tagged = false,
) {
  const plane = new FakeControlPlane();
  const transport = createFakeOpenAITransport({ status });
  const client = plane.wrap(
    new OpenAI({ apiKey: "synthetic-unused", maxRetries: 0, fetch: transport.fetch }),
    { ...options },
  );
  clients.push(client);
  const handler = new SolwynRunScopeHandler(tagged ? { tags: { suite: "synthetic" } } : {});
  const model = await recipeModel(client, handler, fields);
  const chain = prompts.ChatPromptTemplate.fromTemplate("Synthetic {question}")
    .pipe(model)
    .withConfig({ runName: "support-chain", callbacks: [handler] });
  return { plane, transport, client, handler, model, chain };
}

describe("real LangChain/LangGraph with the wrapped provider boundary", () => {
  it("pins runtime chain/tool/retriever argument order with real core", async () => {
    const handler = new SolwynRunScopeHandler();
    const chainStart = vi.spyOn(handler, "handleChainStart");
    const toolStart = vi.spyOn(handler, "handleToolStart");
    const retrieverStart = vi.spyOn(handler, "handleRetrieverStart");
    const manager = callbacks.CallbackManager.configure([handler]);
    if (!manager) throw new Error("missing fixture callback manager");
    const root = await manager.handleChainStart(
      { lc: 1, type: "not_implemented", id: [] },
      {},
      "root",
      "chain",
      [],
      {},
      "named-root",
    );
    const child = await root
      .getChild()
      .handleChainStart(
        { lc: 1, type: "not_implemented", id: [] },
        {},
        "child",
        "chain",
        [],
        {},
        "named-child",
      );
    const tool = await child
      .getChild()
      .handleToolStart({ lc: 1, type: "not_implemented", id: [] }, "synthetic", "tool");
    const retriever = await tool
      .getChild()
      .handleRetrieverStart({ lc: 1, type: "not_implemented", id: [] }, "synthetic", "retriever");
    expect(chainStart.mock.calls[0]?.[3]).toBeUndefined();
    expect(chainStart.mock.calls[0]?.[7]).toBe("named-root");
    expect(chainStart.mock.calls[1]?.[3]).toBe("root");
    expect(toolStart.mock.calls[0]?.[3]).toBe("child");
    expect(retrieverStart.mock.calls[0]?.[3]).toBe("tool");
    await retriever.handleRetrieverEnd([]);
    await tool.handleToolEnd("synthetic");
    await child.handleChainEnd({});
    await root.handleChainEnd({});
  });
  it.each([false, true])("meters chain invoke/stream (stream=%s)", async (stream) => {
    const { chain, client, plane, transport } = await setup();
    if (stream)
      for await (const _ of await chain.stream({ question: "fixture" })) {
        /* drain */
      }
    else await chain.invoke({ question: "fixture" });
    await client.close();
    expect(plane.checks).toHaveLength(1);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      agent_run_name: "langchain:support-chain",
      input_tokens: 11,
      output_tokens: 7,
      status: "success",
    });
    expect(transport.requests).toHaveLength(1);
    if (stream)
      expect(transport.requests[0]?.body["stream_options"]).toMatchObject({ include_usage: true });
    expect(plane.untrackedReports).toHaveLength(0);
  });
  it("releases aborted stream bindings and finishes scopes when upstream terminates the root", async () => {
    const { chain, plane, transport, client, handler } = await setup();
    const starts = vi.spyOn(handler, "handleChainStart");
    const ends = vi.spyOn(handler, "handleChainEnd");
    const errors = vi.spyOn(handler, "handleChainError");
    const bindings = vi.spyOn(handler, "bindModelCall");
    const cancellation = new AbortController();
    const stream = await chain.stream({ question: "fixture" }, { signal: cancellation.signal });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    cancellation.abort(new Error("Synthetic stream cancellation"));
    await expect(
      (async () => {
        while (!(await iterator.next()).done) {
          /* drain until cancellation surfaces */
        }
      })(),
    ).rejects.toThrow();
    await client.close();
    expect(transport.requests).toHaveLength(1);
    expect(plane.checks).toHaveLength(1);
    expect(plane.ingested).toHaveLength(1);
    const options = bindings.mock.results[0]?.value;
    expect(options?.signal?.aborted).toBe(true);
    expect(() =>
      (handler.chatCompletionsLeaf(client) as typeof client).chat.completions.create(
        { model: "gpt-4.1-mini", messages: [] },
        options,
      ),
    ).toThrow(/not admitted/);
    const rootRunId = starts.mock.calls.find((call) => call[3] == null)?.[2];
    expect(rootRunId).toBeDefined();
    if (!rootRunId) throw new Error("missing fixture root run ID");
    const terminated = [...ends.mock.calls, ...errors.mock.calls].some(
      (call) => call[1] === rootRunId,
    );
    if (!terminated) {
      // Core 1.2.18 can reject the pull before resuming the chain generator on Node 22.
      // Model cancellation cannot infer root termination: a sibling may still be running.
      expect(tracker.active.size).toBe(1);
      handler.handleChainError(undefined, rootRunId); // Release the excluded fixture's root.
    }
    expect(tracker.active.size).toBe(0);
  });
  it("purges an early-ended model stream when its graph root completes", async () => {
    const { model, handler, transport } = await setup();
    const upstream = new AbortController();
    const State = graph.Annotation.Root({ done: graph.Annotation<boolean>() });
    const workflow = new graph.StateGraph(State)
      .addNode("answer", async () => {
        for await (const _ of await model.stream("Synthetic stream")) break;
        return { done: true };
      })
      .addEdge(graph.START, "answer")
      .addEdge("answer", graph.END)
      .compile();
    await expect(
      workflow.invoke({}, { callbacks: [handler], signal: upstream.signal }),
    ).resolves.toEqual({ done: true });
    expect(transport.requests).toHaveLength(1);
    expect(tracker.active.size).toBe(0);
  });
  it.each([
    "invoke",
    "values",
    "updates",
    "messages",
  ] as const)("attributes parallel graph nodes for %s", async (mode) => {
    const { model, handler, plane, client } = await setup();
    const State = graph.Annotation.Root({
      a: graph.Annotation<string>(),
      b: graph.Annotation<string>(),
    });
    const workflow = new graph.StateGraph(State)
      .addNode("draft", async () => {
        await model.invoke("Synthetic draft");
        return { a: "done" };
      })
      .addNode("critique", async () => {
        await model.invoke("Synthetic critique");
        return { b: "done" };
      })
      .addEdge(graph.START, "draft")
      .addEdge(graph.START, "critique")
      .addEdge("draft", graph.END)
      .addEdge("critique", graph.END)
      .compile()
      .withConfig({ runName: "support-graph", callbacks: [handler] });
    if (mode === "invoke") await workflow.invoke({});
    else
      for await (const _ of await workflow.stream({}, { streamMode: mode })) {
        /* drain */
      }
    await client.close();
    expect(plane.ingested.map((e) => e.agent_run_name).sort()).toEqual([
      "langchain:critique",
      "langchain:draft",
    ]);
    expect(new Set(plane.ingested.map((e) => e.parent_agent_run_id)).size).toBe(1);
    expect(plane.ingested[0]?.parent_agent_run_id).toBeTruthy();
    expect(plane.ingested[0]?.agent_run_id).not.toBe(plane.ingested[1]?.agent_run_id);
  });
  it.each([
    false,
    true,
  ])("keys queued and concurrent calls to each node (serial graph=%s)", async (serial) => {
    const { model, handler, plane, client } = await setup(
      { leaseEnabled: false },
      { maxConcurrency: 1 },
    );
    const State = graph.Annotation.Root({
      count: graph.Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
    });
    const builder = new graph.StateGraph(State);
    let previous: string = graph.START;
    for (const name of ["one", "two", "three", "four", "pair"] as const) {
      builder
        .addNode(name, async () => {
          await Promise.all(
            Array.from({ length: name === "pair" ? 2 : 1 }, () =>
              model.invoke("Synthetic queued call"),
            ),
          );
          return { count: 1 };
        })
        .addEdge((serial ? previous : graph.START) as never, name as never);
      if (!serial) builder.addEdge(name as never, graph.END);
      previous = name;
    }
    if (serial) builder.addEdge(previous as never, graph.END);
    await builder
      .compile()
      .invoke({}, { callbacks: [handler], ...(serial ? { maxConcurrency: 1 } : {}) });
    await client.close();
    expect(plane.checks).toHaveLength(6);
    expect(plane.ingested.map((e) => e.agent_run_name).sort()).toEqual([
      "langchain:four",
      "langchain:one",
      "langchain:pair",
      "langchain:pair",
      "langchain:three",
      "langchain:two",
    ]);
    expect(plane.ingested.every((e) => e.status === "success")).toBe(true);
    expect(
      new Set(
        plane.ingested
          .filter((e) => e.agent_run_name === "langchain:pair")
          .map((e) => e.agent_run_id),
      ).size,
    ).toBe(1);
  });
  it.each([
    false,
    true,
  ])("reuses a looping node scope and lease (velocity=%s)", async (velocity) => {
    const { model, handler, plane, client, transport } = await setup({
      leaseEnabled: true,
      velocityMode: velocity ? "deny" : "off",
      velocityRepeatCount: 2,
    });
    const State = graph.Annotation.Root({
      count: graph.Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
    });
    const workflow = new graph.StateGraph(State)
      .addNode("agent", async () => {
        await model.invoke("Synthetic repeated call");
        return { count: 1 };
      })
      .addEdge(graph.START, "agent")
      .addConditionalEdges("agent", (state) => (state.count < 3 ? "agent" : graph.END))
      .compile();
    const result = workflow.invoke({}, { callbacks: [handler] });
    if (velocity) await expect(result).rejects.toBeInstanceOf(RunStoppedError);
    else await result;
    await client.close();
    expect(plane.leaseGrants).toHaveLength(1);
    expect(new Set(plane.ingested.map((e) => e.agent_run_id)).size).toBe(1);
    expect(transport.requests).toHaveLength(velocity ? 1 : 3);
  });
  it("keeps nested subgraph nodes distinct even when their names match", async () => {
    const { model, handler, plane, client } = await setup();
    const State = graph.Annotation.Root({ done: graph.Annotation<boolean>() });
    const inner = new graph.StateGraph(State)
      .addNode("agent", async () => {
        await model.invoke("Synthetic inner");
        return { done: true };
      })
      .addEdge(graph.START, "agent")
      .addEdge("agent", graph.END)
      .compile();
    const outer = new graph.StateGraph(State)
      .addNode("agent", async (state, config) => {
        await model.invoke("Synthetic outer");
        return inner.invoke(state, config);
      })
      .addEdge(graph.START, "agent")
      .addEdge("agent", graph.END)
      .compile();
    await outer.invoke({}, { callbacks: [handler] });
    await client.close();
    expect(plane.ingested).toHaveLength(2);
    expect(plane.ingested[0]?.agent_run_name).toBe("langchain:agent");
    expect(plane.ingested[1]?.agent_run_name).toBe("langchain:agent");
    expect(plane.ingested[1]?.agent_run_id).not.toBe(plane.ingested[0]?.agent_run_id);
    expect(plane.ingested[1]?.parent_agent_run_id).toBe(plane.ingested[0]?.agent_run_id);
  });
  it("preserves outer user hierarchy and function-tool binding/withConfig", async () => {
    const { model, handler, plane, client } = await setup();
    const tools = model
      .bindTools([
        {
          type: "function",
          function: {
            name: "synthetic_tool",
            description: "Synthetic",
            parameters: { type: "object", properties: {} },
          },
        },
      ])
      .withConfig({ tags: ["synthetic"] });
    await run("outer", async () => {
      await prompts.ChatPromptTemplate.fromTemplate("Synthetic")
        .pipe(tools)
        .invoke({}, { runName: "tools-chain", callbacks: [handler] });
    });
    await client.close();
    expect(plane.ingested[0]).toMatchObject({ agent_run_name: "langchain:tools-chain" });
    expect(plane.ingested[0]?.parent_agent_run_id).toBeTruthy();
  });
  it.each([
    ["parse", "LangChain client member is not admitted"],
    ["events", "LangChain chat-model stream events are not admitted"],
    ["unparented", "LangChain run requires a mapped parent chain"],
    ["override", "LangChain call has no bound Solwyn signal key; path is not admitted"],
  ] as const)("fails closed on %s", async (path, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { chain, model, handler, plane, transport } = await setup();
    const started = performance.now();
    let operation: Promise<unknown>;
    if (path === "parse")
      operation = prompts.ChatPromptTemplate.fromTemplate("Synthetic")
        .pipe(
          model.withStructuredOutput(
            { title: "Synthetic", type: "object", properties: { answer: { type: "string" } } },
            { method: "jsonSchema" },
          ),
        )
        .invoke({}, { callbacks: [handler] });
    else if (path === "events") operation = model._streamChatModelEvents([], {}).next();
    else if (path === "unparented") operation = model.invoke("Synthetic", { callbacks: [handler] });
    else
      operation = chain.invoke(
        { question: "fixture" },
        (path === "override"
          ? { options: { signal: new AbortController().signal } }
          : {}) as Parameters<typeof chain.invoke>[1],
      );
    await expect(operation).rejects.toMatchObject({ constructor: SolwynError, message });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(transport.requests).toHaveLength(0);
    expect(plane.checks).toHaveLength(0);
  });
  it.each([
    ["explicit", false],
    ["explicit", true],
    ["reasoning", false],
    ["reasoning", true],
    ["hosted tool", false],
  ] as const)("preserves the Responses refusal for %s (stream=%s)", async (selection, stream) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { model, handler, plane, transport, client } = await setup(
      {},
      selection === "explicit"
        ? { useResponsesApi: true }
        : selection === "reasoning"
          ? { reasoning: { summary: "auto" } }
          : {},
    );
    const selected =
      selection === "hosted tool" ? model.bindTools([{ type: "web_search_preview" }]) : model;
    const chain = prompts.ChatPromptTemplate.fromTemplate("Synthetic")
      .pipe(selected)
      .withConfig({ callbacks: [handler] });
    const operation = stream
      ? (async () => {
          for await (const _ of await chain.stream({})) {
            /* drain */
          }
        })()
      : chain.invoke({});
    await expect(operation).rejects.toMatchObject({
      constructor: SolwynError,
      message: "LangChain Responses API is not admitted",
    });
    await client.close();
    expect(transport.requests).toHaveLength(0);
    expect(plane.checks).toHaveLength(0);
    expect(plane.ingested).toHaveLength(0);
  });
  it("meters hosted-tool streaming through the Chat Completions leaf", async () => {
    const { model, handler, plane, transport, client } = await setup();
    const chain = prompts.ChatPromptTemplate.fromTemplate("Synthetic")
      .pipe(model.bindTools([{ type: "web_search_preview" }]))
      .withConfig({ runName: "hosted-tool-chain", callbacks: [handler] });
    for await (const _ of await chain.stream({})) {
      /* drain */
    }
    await client.close();
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.url).toMatch(/\/chat\/completions$/);
    expect(plane.checks).toHaveLength(1);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.agent_run_name).toBe("langchain:hosted-tool-chain");
  });
  it("preserves the chat-model events refusal through the real callback error path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { chain, plane, transport } = await setup();
    const { BaseCallbackHandler } = await import("@langchain/core/callbacks/base");
    class EventHandler extends BaseCallbackHandler {
      name = "synthetic_events";
      lc_prefer_chat_model_stream_events = true;
    }
    await expect(
      chain.invoke(
        { question: "fixture" },
        {
          callbacks: [new EventHandler()],
        },
      ),
    ).rejects.toMatchObject({
      constructor: SolwynError,
      message: "LangChain chat-model stream events are not admitted",
    });
    expect(transport.requests).toHaveLength(0);
    expect(plane.checks).toHaveLength(0);
  });
  it.each([
    false,
    true,
  ])("raises a post-hoc error for a successful unbound model (stream=%s)", async (stream) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, transport } = await setup();
    const plain = new LC.ChatOpenAI({
      model: "gpt-4.1-mini",
      apiKey: "synthetic-unused",
      maxRetries: 0,
      configuration: { fetch: transport.fetch },
    });
    const chain = prompts.ChatPromptTemplate.fromTemplate("Synthetic")
      .pipe(plain)
      .withConfig({ callbacks: [handler] });
    const operation = stream
      ? (async () => {
          for await (const _ of await chain.stream({})) {
            /* drain */
          }
        })()
      : chain.invoke({});
    await expect(operation).rejects.toThrow(/not metered/);
    expect(transport.requests).toHaveLength(1);
  });
  it.each([false, true])("vetoes default retries on budget denial (tagged=%s)", async (tagged) => {
    const { plane, chain, transport, client } = await setup(
      { leaseEnabled: true },
      { maxRetries: 6 },
      200,
      tagged,
    );
    plane.denyNext(1, { scope: tagged ? "check" : "lease" });
    const started = performance.now();
    await expect(chain.invoke({ question: "fixture" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(performance.now() - started).toBeLessThan(1000);
    await client.close();
    expect(plane.checks.length + plane.leaseGrants.length).toBe(1);
    expect(transport.requests).toHaveLength(0);
    expect(plane.denialReceipts).toHaveLength(1);
  });
  it("keeps LangChain's 401 classification with default retries", async () => {
    const { chain, transport } = await setup({ leaseEnabled: false }, { maxRetries: 6 }, 401);
    await expect(chain.invoke({ question: "fixture" })).rejects.toMatchObject({ status: 401 });
    expect(transport.requests).toHaveLength(1);
  });
  it("retries a provider 500 using LangChain's default classifier", async () => {
    const { chain, transport } = await setup(
      { leaseEnabled: false },
      { maxRetries: 1 },
      [500, 200],
    );
    await chain.invoke({ question: "fixture" });
    expect(transport.requests).toHaveLength(2);
  }, 10_000);
  it("surfaces an exact-run stop at the next provider chunk boundary", async () => {
    const { chain, plane } = await setup();
    const stream = await chain.stream({ question: "fixture" });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const runId = plane.checks[0]?.agent_run_id;
    expect(runId).toBeTruthy();
    if (!runId) throw new Error("missing fixture run ID");
    markTerminated(runId, { reason: "manual_kill", source: "server" });
    try {
      await expect(
        (async () => {
          while (!(await iterator.next()).done) {
            /* drain */
          }
        })(),
      ).rejects.toBeInstanceOf(RunStoppedError);
    } finally {
      clearRunTermination(runId);
    }
  });
});
