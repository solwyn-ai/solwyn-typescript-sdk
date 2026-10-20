import type * as Agents from "@openai/agents";
import type OpenAI from "openai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  ConfigurationError,
  RunStoppedError,
  SolwynError,
} from "../../src/errors";
import { SolwynAgents, solwynToolErrorFunction } from "../../src/openai-agents/index";
import {
  type DetachedRun,
  getCurrentRun,
  getDetachedRunFactory,
  resetDetachedRunFactory,
  setDetachedRunFactory,
} from "../../src/run-context";
import { clearRunTermination, markTerminated } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing/index";
import { createFakeOpenAITransport } from "../helpers/fake-openai-transport";
import { installIntegrationEnv } from "../helpers/integration-env";
import { createAgentsTransport } from "../helpers/openai-agents-transport";

let framework: typeof Agents;
let OpenAIClient: typeof OpenAI;
let env: ReturnType<typeof installIntegrationEnv>;

beforeAll(async () => {
  env = installIntegrationEnv();
  await import("../../src/node");
  framework = await import("@openai/agents");
  framework.setTracingDisabled(true);
  OpenAIClient = (await import("openai")).default;
});
afterAll(() => env.restore());
afterEach(() => {
  expect(env.fetchAttempts).toEqual([]);
  expect(env.socketAttempts()).toBe(0);
});

function setup(
  api: "chat_completions" | "responses" = "chat_completions",
  settings: {
    transport?: ReturnType<typeof createFakeOpenAITransport>;
    wrap?: Parameters<FakeControlPlane["wrap"]>[1];
  } = {},
) {
  const plane = new FakeControlPlane();
  const transport = settings.transport ?? createFakeOpenAITransport();
  const raw = new OpenAIClient({
    apiKey: "synthetic-unused",
    baseURL: "https://provider.invalid/v1",
    fetch: transport.fetch,
    maxRetries: 0,
  });
  const client = plane.wrap(raw, { provider: "openai", onUnmetered: "raise", ...settings.wrap });
  const integration = new SolwynAgents({ client, OpenAIProvider: framework.OpenAIProvider, api });
  const runner = new framework.Runner({
    modelProvider: integration.modelProvider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });
  const agent = new framework.Agent({ name: "Worker", model: "gpt-4.1-mini" });
  return { plane, transport, client, integration, runner, agent, raw };
}

describe("OpenAI Agents HTTP attribution", () => {
  it.each([
    "chat_completions",
    "responses",
  ] as const)("meters %s with and without streaming", async (api) => {
    for (const streamed of [false, true]) {
      const { plane, transport, client, integration, runner, agent } = setup(api);
      try {
        const options = { workflow: "support-workflow", tags: { team: "support" } };
        if (streamed) {
          const result = await integration.runStreamed(runner, agent, "Synthetic input.", options);
          for await (const _event of result) {
            /* drain */
          }
          await result.completed;
          expect(result.finalOutput).toBe("Synthetic reply.");
        } else {
          const result = await integration.run(runner, agent, "Synthetic input.", options);
          expect(result.finalOutput).toBe("Synthetic reply.");
        }
      } finally {
        await client.close();
      }
      expect(transport.requests).toHaveLength(1);
      expect(plane.checks).toHaveLength(1);
      expect(plane.confirms).toHaveLength(1);
      expect(plane.leaseGrants).toHaveLength(0);
      expect(plane.ingested).toHaveLength(1);
      expect(plane.ingested[0]).toMatchObject({
        status: "success",
        agent_run_name: "agent:Worker",
        tags: { team: "support" },
        input_tokens: 11,
        output_tokens: 7,
      });
      expect(plane.ingested[0]?.parent_agent_run_id).toMatch(/^run_/);
      expect(plane.untrackedReports).toEqual([]);
      expect(plane.unmatchedRequests).toEqual([]);
      if (streamed && api === "chat_completions")
        expect(transport.requests[0]?.body["stream_options"]).toEqual({ include_usage: true });
      expect(
        (integration as unknown as { invocations: Map<string, unknown> }).invocations.size,
      ).toBe(0);
    }
  });

  it("requires the Node seam and an actually wrapped client", async () => {
    const { client, raw } = setup();
    const factory = getDetachedRunFactory();
    if (factory === undefined) throw new Error("Node test seam missing");
    try {
      expect(
        () => new SolwynAgents({ client: raw, OpenAIProvider: framework.OpenAIProvider }),
      ).toThrow(ConfigurationError);
      resetDetachedRunFactory();
      expect(() => new SolwynAgents({ client, OpenAIProvider: framework.OpenAIProvider })).toThrow(
        /@solwyn\/sdk\/node/,
      );
    } finally {
      setDetachedRunFactory(factory);
      await client.close();
    }
  });

  it("attaches idempotently and refuses a foreign provider or Model instance on the runner", async () => {
    const { client, raw, integration, runner } = setup();
    try {
      const on = vi.spyOn(runner, "on");
      integration.attach(runner);
      integration.attach(runner);
      expect(on.mock.calls.filter(([event]) => event === "agent_start")).toHaveLength(1);
      expect(() => integration.attach(new framework.Runner())).toThrow(SolwynError);
      const model = await new framework.OpenAIProvider({ openAIClient: raw }).getModel(
        "gpt-4.1-mini",
      );
      expect(() =>
        integration.attach(
          new framework.Runner({ modelProvider: integration.modelProvider, model }),
        ),
      ).toThrow(SolwynError);
    } finally {
      await client.close();
    }
  });

  it("refuses model dispatch outside a workflow", async () => {
    const { client, integration, transport } = setup();
    try {
      const model = await integration.modelProvider.getModel("gpt-4.1-mini");
      await expect(model.getResponse({} as Agents.ModelRequest)).rejects.toBeInstanceOf(
        SolwynError,
      );
      expect(transport.requests).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("refuses a Model instance on the agent before dispatch", async () => {
    const { client, raw, integration, runner, transport } = setup();
    try {
      const model = await new framework.OpenAIProvider({ openAIClient: raw }).getModel(
        "gpt-4.1-mini",
      );
      const agent = new framework.Agent({ name: "Bypass", model });
      await expect(
        integration.run(runner, agent, "Synthetic input.", { workflow: "workflow" }),
      ).rejects.toBeInstanceOf(SolwynError);
      expect(transport.requests).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("propagates a denial once even under a permissive runner retry policy", async () => {
    const { client, integration, transport, plane } = setup();
    const runner = new framework.Runner({
      modelProvider: integration.modelProvider,
      tracingDisabled: true,
      modelSettings: {
        retry: { maxRetries: 2, policy: () => true, backoff: { initialDelayMs: 0, jitter: false } },
      },
    });
    const agent = new framework.Agent({ name: "Denied", model: "solwyn-test/deny" });
    try {
      await expect(
        integration.run(runner, agent, "Synthetic input.", {
          workflow: "workflow",
          tags: { team: "support" },
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
    } finally {
      await client.close();
    }
    expect(transport.requests).toHaveLength(0);
    expect(plane.checks).toHaveLength(1);
    expect(plane.denialReceipts).toHaveLength(1);
  });
});

async function invoke(setupResult: ReturnType<typeof setup>, streamed: boolean, tagged = true) {
  const { integration, runner, agent } = setupResult;
  const options = { workflow: "workflow", ...(tagged ? { tags: { team: "support" } } : {}) };
  if (!streamed) return integration.run(runner, agent, "Synthetic input.", options);
  const result = await integration.runStreamed(runner, agent, "Synthetic input.", options);
  for await (const _event of result) {
    /* drain */
  }
  await result.completed;
  return result;
}

describe("OpenAI Agents hierarchy and enforcement", () => {
  it.each([
    "chat_completions",
    "responses",
  ] as const)("reuses the agent run and one lease through %s tool turns", async (api) => {
    for (const streamed of [false, true]) {
      const transport = createAgentsTransport([{ kind: "tool", name: "lookup" }, { kind: "text" }]);
      const state = setup(api, { transport });
      state.agent.tools = [
        framework.tool({
          name: "lookup",
          description: "Synthetic lookup",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
          errorFunction: solwynToolErrorFunction,
          execute: () => "Synthetic result.",
        }),
      ];
      try {
        await invoke(state, streamed, false);
      } finally {
        await state.client.close();
      }
      expect(transport.requests).toHaveLength(2);
      expect(state.plane.checks).toHaveLength(0);
      expect(state.plane.leaseGrants).toHaveLength(1);
      expect(state.plane.confirms).toHaveLength(2);
      expect(state.plane.ingested.map((event) => event.status)).toEqual(["success", "success"]);
      expect(new Set(state.plane.ingested.map((event) => event.agent_run_id)).size).toBe(1);
    }
  });

  it.each([
    "chat_completions",
    "responses",
  ] as const)("keeps %s handoff targets as siblings and reuses a hand-back identity", async (api) => {
    for (const streamed of [false, true]) {
      const transport = createAgentsTransport([
        { kind: "tool", name: "transfer_to_Specialist" },
        { kind: "tool", name: "transfer_to_Worker" },
        { kind: "text" },
      ]);
      const state = setup(api, { transport });
      const specialist = new framework.Agent({
        name: "Specialist",
        model: "gpt-4.1-mini",
        handoffs: [state.agent],
      });
      state.agent.handoffs = [specialist];
      try {
        await invoke(state, streamed, false);
      } finally {
        await state.client.close();
      }
      expect(transport.requests).toHaveLength(3);
      expect(state.plane.leaseGrants).toHaveLength(2);
      const [first, second, third] = state.plane.ingested;
      expect(first?.agent_run_name).toBe("agent:Worker");
      expect(second?.agent_run_name).toBe("agent:Specialist");
      expect(third?.agent_run_id).toBe(first?.agent_run_id);
      expect(second?.agent_run_id).not.toBe(first?.agent_run_id);
      expect(new Set(state.plane.ingested.map((event) => event.parent_agent_run_id)).size).toBe(1);
    }
  });

  it.each([
    false,
    true,
  ])("isolates three concurrent invocations (streamed=%s)", async (streamed) => {
    const state = setup();
    try {
      await Promise.all(
        [0, 1, 2].map(async (index) => {
          const options = { workflow: `workflow-${index}`, tags: { lane: String(index) } };
          if (!streamed)
            return state.integration.run(state.runner, state.agent, "Synthetic input.", options);
          const result = await state.integration.runStreamed(
            state.runner,
            state.agent,
            "Synthetic input.",
            options,
          );
          for await (const _event of result) {
            /* drain */
          }
          await result.completed;
        }),
      );
    } finally {
      await state.client.close();
    }
    expect(state.plane.ingested).toHaveLength(3);
    expect(new Set(state.plane.ingested.map((event) => event.agent_run_id)).size).toBe(3);
    expect(new Set(state.plane.ingested.map((event) => event.parent_agent_run_id)).size).toBe(3);
    expect(new Set(state.plane.ingested.map((event) => event.tags?.["lane"]))).toEqual(
      new Set(["0", "1", "2"]),
    );
  });

  it("creates the workflow in an enclosing user run's frame", async () => {
    const { run, currentRunContext } = await import("../../src/node");
    const factory = getDetachedRunFactory();
    if (factory === undefined) throw new Error("Node test seam missing");
    const parents: Array<{ name: string; parent: string | null; id: string }> = [];
    setDetachedRunFactory((name, options) => {
      const handle = factory(name, options);
      parents.push({ name, parent: currentRunContext().agentRunId, id: handle.runId });
      return handle;
    });
    const state = setup();
    let outerId: string | null = null;
    try {
      await run("outer", async () => {
        outerId = currentRunContext().agentRunId;
        await invoke(state, false);
      });
    } finally {
      setDetachedRunFactory(factory);
      await state.client.close();
    }
    expect(parents).toEqual([
      { name: "workflow", parent: outerId, id: parents[0]?.id },
      { name: "agent:Worker", parent: parents[0]?.id, id: parents[1]?.id },
    ]);
    expect(state.plane.ingested[0]?.agent_run_id).toBe(parents[1]?.id);
  });

  it.each([
    false,
    true,
  ])("accounts for a runner-managed 500 retry in both receipt lanes (streamed=%s)", async (streamed) => {
    for (const api of ["chat_completions", "responses"] as const)
      for (const tagged of [false, true]) {
        const transport = createFakeOpenAITransport({ status: [500, 200] });
        const state = setup(api, { transport });
        state.runner.config.modelSettings = {
          retry: {
            maxRetries: 1,
            policy: framework.retryPolicies.providerSuggested(),
            backoff: { initialDelayMs: 0, jitter: false },
          },
        };
        try {
          await invoke(state, streamed, tagged);
        } finally {
          await state.client.close();
        }
        expect(transport.requests).toHaveLength(2);
        expect(state.plane.checks).toHaveLength(tagged ? 2 : 0);
        expect(state.plane.leaseGrants).toHaveLength(tagged ? 0 : 1);
        expect(state.plane.confirms).toHaveLength(1);
        expect(state.plane.ingested.map((event) => event.status)).toEqual(["error", "success"]);
        expect(state.plane.confirms[0]?.call_id).toBe(state.plane.ingested[1]?.call_id);
        expect(state.plane.confirms[0]?.call_id).not.toBe(state.plane.ingested[0]?.call_id);
        expect(new Set(state.plane.ingested.map((event) => event.agent_run_id)).size).toBe(1);
      }
  });

  it.each([
    "solwyn-test/deny",
    "solwyn-test/deny-stopped",
  ])("surfaces %s from all four HTTP lanes", async (model) => {
    for (const api of ["chat_completions", "responses"] as const)
      for (const streamed of [false, true]) {
        const state = setup(api);
        state.agent.model = model;
        state.runner.config.modelSettings = {
          retry: {
            maxRetries: 2,
            policy: () => true,
            backoff: { initialDelayMs: 0, jitter: false },
          },
        };
        try {
          await expect(invoke(state, streamed)).rejects.toBeInstanceOf(
            model.endsWith("stopped") ? RunStoppedError : BudgetExceededError,
          );
        } finally {
          await state.client.close();
        }
        expect(state.transport.requests).toHaveLength(0);
        expect(state.plane.checks).toHaveLength(1);
        expect(state.plane.denialReceipts).toHaveLength(1);
        expect(
          (state.integration as unknown as { invocations: Map<string, unknown> }).invocations.size,
        ).toBe(0);
      }
  });
});

describe("OpenAI Agents fail-closed boundaries", () => {
  it.each([
    { background: true },
    { extra_query: { synthetic: "value" } },
  ])("keeps Responses transport overrides behind core enforcement (%j)", async (providerData) => {
    for (const streamed of [false, true]) {
      const state = setup("responses");
      state.agent = new framework.Agent({
        name: "Worker",
        model: "gpt-4.1-mini",
        modelSettings: { providerData },
      });
      try {
        await expect(invoke(state, streamed)).rejects.toBeInstanceOf(ConfigurationError);
      } finally {
        await state.client.close();
      }
      expect(state.transport.requests).toHaveLength(0);
    }
  });

  it("validates the API selector before constructing a delegate", async () => {
    const state = setup();
    try {
      expect(
        () =>
          new SolwynAgents({
            client: state.client,
            OpenAIProvider: framework.OpenAIProvider,
            api: "unknown" as "responses",
          }),
      ).toThrow(ConfigurationError);
    } finally {
      await state.client.close();
    }
  });

  it("rejects an absent delegate model with a typed error", async () => {
    const state = setup();
    class MissingModelProvider extends framework.OpenAIProvider {
      override async getModel(): Promise<Agents.Model> {
        return null as unknown as Agents.Model;
      }
    }
    try {
      const integration = new SolwynAgents({
        client: state.client,
        OpenAIProvider: MissingModelProvider,
      });
      await expect(integration.modelProvider.getModel()).rejects.toBeInstanceOf(SolwynError);
    } finally {
      await state.client.close();
    }
  });
  it.each([
    false,
    true,
  ])("refuses explicitly nested integration workflows (inner streamed=%s)", async (streamed) => {
    const state = setup("chat_completions", {
      transport: createAgentsTransport([{ kind: "tool", name: "nested" }, { kind: "text" }]),
    });
    const inner = new framework.Agent({ name: "Inner", model: "gpt-4.1-mini" });
    state.agent.tools = [
      framework.tool({
        name: "nested",
        description: "Synthetic nested workflow",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        execute: async () => {
          if (!streamed)
            return state.integration.run(state.runner, inner, "Synthetic input.", {
              workflow: "nested",
            });
          return state.integration.runStreamed(state.runner, inner, "Synthetic input.", {
            workflow: "nested",
          });
        },
      }),
    ];
    state.agent.toolUseBehavior = "stop_on_first_tool";
    try {
      await expect(invoke(state, false)).rejects.toThrow(/nested/);
    } finally {
      await state.client.close();
    }
    expect(state.transport.requests).toHaveLength(1);
  });
  it("forces HTTP even when the global Responses transport selects websockets", async () => {
    framework.setOpenAIResponsesTransport("websocket");
    const state = setup("responses");
    try {
      await invoke(state, false);
    } finally {
      framework.setOpenAIResponsesTransport("http");
      await state.client.close();
    }
    expect(state.transport.requests).toHaveLength(1);
  });

  it("refuses websocket and unknown delegate model shapes", async () => {
    const state = setup("responses");
    try {
      for (const model of [
        new framework.OpenAIResponsesWSModel(state.raw, "gpt-4.1-mini"),
        {
          getResponse: async () => {
            throw new Error("must not dispatch");
          },
          getStreamedResponse: () => {
            throw new Error("must not dispatch");
          },
        },
      ]) {
        class UnexpectedProvider extends framework.OpenAIProvider {
          override async getModel() {
            return model;
          }
        }
        const integration = new SolwynAgents({
          client: state.client,
          OpenAIProvider: UnexpectedProvider,
          api: "responses",
        });
        await expect(integration.modelProvider.getModel()).rejects.toBeInstanceOf(SolwynError);
      }
    } finally {
      await state.client.close();
    }
    expect(state.transport.requests).toHaveLength(0);
  });

  it("admits renamed HTTP model classes and forwards prompt-model selection", async () => {
    const originalName = Object.getOwnPropertyDescriptor(framework.OpenAIResponsesModel, "name");
    Object.defineProperty(framework.OpenAIResponsesModel, "name", {
      value: "a",
      configurable: true,
    });
    const state = setup("responses");
    try {
      const model = await state.integration.modelProvider.getModel();
      expect(model.supportsPromptModelSelection).toBe(true);
      await invoke(state, false);
    } finally {
      if (originalName !== undefined)
        Object.defineProperty(framework.OpenAIResponsesModel, "name", originalName);
      await state.client.close();
    }
  });

  it("vetoes branded errors without reading the retry request and delegates ordinary errors", async () => {
    const state = setup();
    try {
      const model = await state.integration.modelProvider.getModel();
      const args = {
        error: new SolwynError("synthetic decision"),
        get request(): never {
          throw new Error("request inspected");
        },
      } as unknown as Agents.ModelRetryAdviceRequest;
      expect(await model.getRetryAdvice?.(args)).toEqual({
        suggested: false,
        replaySafety: "unsafe",
        reason: "solwyn_decision",
      });
      const ordinaryArgs = {
        error: Object.assign(new Error("synthetic failure"), { status: 500 }),
        request: {},
      } as Agents.ModelRetryAdviceRequest;
      expect(await model.getRetryAdvice?.(ordinaryArgs)).toMatchObject({ suggested: true });
    } finally {
      await state.client.close();
    }
  });

  it("refuses a model call before an agent starts", async () => {
    const state = setup();
    const model = await state.integration.modelProvider.getModel();
    state.agent.inputGuardrails = [
      {
        name: "synthetic_guardrail",
        runInParallel: false,
        execute: async () => {
          await model.getResponse({} as Agents.ModelRequest);
          return { outputInfo: null, tripwireTriggered: false };
        },
      },
    ];
    try {
      await expect(invoke(state, false)).rejects.toThrow(/no active agent/);
    } finally {
      await state.client.close();
    }
    expect(state.transport.requests).toHaveLength(0);
  });

  it("latches a concurrent model attempt found from an active agent's frame", async () => {
    const base = createFakeOpenAITransport();
    let nestedCall = async () => {};
    const state = setup("chat_completions", {
      transport: {
        requests: base.requests,
        fetch: async (...args) => {
          await nestedCall();
          return base.fetch(...args);
        },
      },
    });
    const model = await state.integration.modelProvider.getModel();
    const nested: unknown[] = [];
    nestedCall = async () => {
      try {
        await model.getResponse({} as Agents.ModelRequest);
      } catch (error) {
        nested.push(error);
      }
    };
    try {
      await expect(invoke(state, false)).rejects.toThrow(/concurrent model attempts/);
    } finally {
      await state.client.close();
    }
    expect(nested).toHaveLength(1);
    expect(nested[0]).toBeInstanceOf(SolwynError);
    expect(state.transport.requests).toHaveLength(1);
  });

  it("finds an invocation by parentAgentRunId in a nested frame", async () => {
    const { run } = await import("../../src/node");
    const base = createFakeOpenAITransport();
    let nestedCall = async () => {};
    const state = setup("chat_completions", {
      transport: {
        requests: base.requests,
        fetch: async (...args) => {
          await nestedCall();
          return base.fetch(...args);
        },
      },
    });
    const model = await state.integration.modelProvider.getModel();
    nestedCall = async () => {
      await expect(
        run("structural-child", () => model.getResponse({} as Agents.ModelRequest)),
      ).rejects.toThrow(/concurrent model attempts/);
    };
    try {
      await expect(invoke(state, false)).rejects.toThrow(/concurrent model attempts/);
    } finally {
      await state.client.close();
    }
  });
  it.each([
    false,
    true,
  ])("latches nested asTool violations including stop_on_first_tool (streamed=%s)", async (streamed) => {
    for (const stopFirst of [false, true]) {
      const state = setup("chat_completions", {
        transport: createAgentsTransport([
          { kind: "tool", name: "inner_tool", args: '{"input":"Synthetic input."}' },
          { kind: "text" },
        ]),
      });
      const inner = new framework.Agent({ name: "Inner", model: "gpt-4.1-mini" });
      state.agent.tools = [
        inner.asTool({ toolName: "inner_tool", toolDescription: "Synthetic nested run" }),
      ];
      if (stopFirst) state.agent.toolUseBehavior = "stop_on_first_tool";
      try {
        if (!streamed) {
          await expect(invoke(state, false)).rejects.toBeInstanceOf(SolwynError);
        } else {
          const result = await state.integration.runStreamed(
            state.runner,
            state.agent,
            "Synthetic input.",
            { workflow: "workflow", tags: { team: "support" } },
          );
          await expect(
            (async () => {
              for await (const _event of result) {
                /* drain */
              }
            })(),
          ).rejects.toBeInstanceOf(SolwynError);
          await expect(result.completed).rejects.toBeInstanceOf(SolwynError);
        }
      } finally {
        await state.client.close();
      }
      expect(state.transport.requests).toHaveLength(1);
      expect(
        (state.integration as unknown as { invocations: Map<string, unknown> }).invocations.size,
      ).toBe(0);
    }
  });

  it.each([
    "",
    " ",
    "bad\nname",
    "\ud800",
    "a".repeat(250),
  ])("rejects an invalid agent name (%j)", async (name) => {
    const state = setup();
    state.agent.name = name;
    try {
      await expect(invoke(state, false)).rejects.toBeInstanceOf(SolwynError);
    } finally {
      await state.client.close();
    }
    expect(state.transport.requests).toHaveLength(0);
  });

  it("refuses overlapping agent_start hooks", async () => {
    const state = setup();
    state.integration.attach(state.runner);
    state.runner.on("agent_start", (context, agent) =>
      state.runner.emit("agent_start", context, agent),
    );
    try {
      await expect(invoke(state, false)).rejects.toThrow(/overlapping agent_start/);
    } finally {
      await state.client.close();
    }
    expect(state.transport.requests).toHaveLength(0);
  });

  it("rejects RunState resume before invoking the framework", async () => {
    const state = setup();
    const run = vi.spyOn(state.runner, "run");
    try {
      await expect(
        state.integration.run(state.runner, state.agent, {} as unknown as string, {
          workflow: "workflow",
        }),
      ).rejects.toThrow(/RunState/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await state.client.close();
    }
  });
});

describe("OpenAI Agents stream and handle lifecycle", () => {
  function trackRuns() {
    const factory = getDetachedRunFactory();
    if (factory === undefined) throw new Error("Node test seam missing");
    const handles: DetachedRun[] = [];
    const deferred: string[] = [];
    setDetachedRunFactory((name, options) => {
      const handle = factory(name, options);
      handles.push(handle);
      return {
        runId: handle.runId,
        activate: (fn) => handle.activate(fn),
        tryFinish: () => {
          const finished = handle.tryFinish();
          if (!finished) deferred.push(handle.runId);
          return finished;
        },
      };
    });
    return { handles, deferred, restore: () => setDetachedRunFactory(factory) };
  }

  it.each([
    "success",
    "error",
    "max-turns",
    "stream",
    "early-return",
  ])("finishes every handle after %s", async (scenario) => {
    const tracker = trackRuns();
    const state = setup(
      "chat_completions",
      scenario === "error"
        ? { transport: createFakeOpenAITransport({ status: 401 }) }
        : scenario === "max-turns"
          ? { transport: createAgentsTransport([{ kind: "tool", name: "lookup" }]) }
          : {},
    );
    if (scenario === "max-turns") {
      state.agent.tools = [
        framework.tool({
          name: "lookup",
          description: "Synthetic lookup",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
          execute: () => "Synthetic result.",
        }),
      ];
    }
    try {
      if (scenario === "error") await expect(invoke(state, false)).rejects.toBeInstanceOf(Error);
      else if (scenario === "max-turns")
        await expect(
          state.integration.run(state.runner, state.agent, "Synthetic input.", {
            workflow: "workflow",
            runOptions: { maxTurns: 1 },
          }),
        ).rejects.toBeInstanceOf(framework.MaxTurnsExceededError);
      else if (scenario === "early-return") {
        const result = await state.integration.runStreamed(
          state.runner,
          state.agent,
          "Synthetic input.",
          { workflow: "workflow" },
        );
        const iterator = result[Symbol.asyncIterator]();
        await iterator.return?.();
        // Agents may reject completion with its provider's abort error after cancellation.
        await result.completed.then(
          () => undefined,
          () => undefined,
        );
        expect(result.cancelled).toBe(true);
      } else await invoke(state, scenario === "stream");
      expect(
        (state.integration as unknown as { invocations: Map<string, unknown> }).invocations.size,
      ).toBe(0);
      for (const handle of tracker.handles)
        expect(() => handle.activate(() => undefined)).toThrow(/finished/);
      if (scenario === "max-turns") expect(tracker.handles).toHaveLength(2);
    } finally {
      tracker.restore();
      await state.client.close();
    }
  });

  it("aborts a stopped run at the next provider chunk", async () => {
    const transport = createFakeOpenAITransport();
    let runId: string | undefined;
    const state = setup("chat_completions", {
      transport: {
        requests: transport.requests,
        fetch: async (...args) => {
          runId = getCurrentRun()?.agentRunId;
          const response = await transport.fetch(...args);
          if (runId === undefined) throw new Error("missing leaf attribution");
          const frames = (await response.text()).split("\n\n").filter(Boolean);
          const leafRunId = runId;
          let index = 0;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (index === 2)
                    markTerminated(leafRunId, { source: "server", reason: "manual_kill" });
                  const frame = frames[index++];
                  if (frame === undefined) controller.close();
                  else controller.enqueue(new TextEncoder().encode(`${frame}\n\n`));
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: response.headers },
          );
        },
      },
    });
    let sawDelta = false;
    try {
      const result = await state.integration.runStreamed(
        state.runner,
        state.agent,
        "Synthetic input.",
        { workflow: "workflow", tags: { team: "support" } },
      );
      await expect(
        (async () => {
          for await (const event of result) {
            if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta")
              sawDelta = true;
          }
        })(),
      ).rejects.toBeInstanceOf(RunStoppedError);
    } finally {
      if (runId !== undefined) clearRunTermination(runId);
      await state.client.close();
    }
    expect(transport.requests).toHaveLength(1);
    expect(sawDelta).toBe(true);
  });

  it("defers finishing active handles when completion races provider work and retries after it settles", async () => {
    const tracker = trackRuns();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const transport = createFakeOpenAITransport();
    const state = setup("chat_completions", {
      transport: {
        requests: transport.requests,
        fetch: async (...args) => {
          started();
          await gate;
          return transport.fetch(...args);
        },
      },
    });
    const nativeRun = state.runner.run.bind(state.runner);
    vi.spyOn(state.runner, "run").mockImplementation(async (...args) => {
      const result = await nativeRun(...args);
      Object.defineProperty(result, "completed", { value: completion, configurable: true });
      return result;
    });
    try {
      const result = await state.integration.runStreamed(
        state.runner,
        state.agent,
        "Synthetic input.",
        { workflow: "workflow" },
      );
      await entered;
      complete();
      await result.completed;
      expect(tracker.deferred).not.toHaveLength(0);
      release();
      await vi.waitFor(() =>
        expect(
          (state.integration as unknown as { invocations: Map<string, unknown> }).invocations.size,
        ).toBe(0),
      );
      for (const handle of tracker.handles)
        expect(() => handle.activate(() => undefined)).toThrow(/finished/);
    } finally {
      release();
      tracker.restore();
      await state.client.close();
    }
  });

  it.each([
    "complete",
    "return",
    "throw",
  ])("activates iterator creation and each provider operation, never across a yield (%s)", async (mode) => {
    const state = setup();
    const frames: Array<string | undefined> = [];
    const delegate = new framework.OpenAIChatCompletionsModel(state.raw, "gpt-4.1-mini");
    const error = new Error("synthetic iterator error");
    let pulls = 0;
    vi.spyOn(delegate, "getStreamedResponse").mockImplementation(() => {
      frames.push(getCurrentRun()?.agentRunId);
      return {
        [Symbol.asyncIterator]() {
          frames.push(getCurrentRun()?.agentRunId);
          return {
            next: async () => {
              frames.push(getCurrentRun()?.agentRunId);
              return { done: pulls++ > 0, value: {} as Agents.StreamEvent };
            },
            return: async () => {
              frames.push(getCurrentRun()?.agentRunId);
              return { done: true as const, value: undefined };
            },
            throw: async () => {
              frames.push(getCurrentRun()?.agentRunId);
              throw error;
            },
          };
        },
      };
    });
    class ProbeProvider extends framework.OpenAIProvider {
      override async getModel() {
        return delegate;
      }
    }
    const integration = new SolwynAgents({ client: state.client, OpenAIProvider: ProbeProvider });
    const runner = new framework.Runner({
      modelProvider: integration.modelProvider,
      tracingDisabled: true,
    });
    const consumerFrames: Array<string | undefined> = [];
    vi.spyOn(runner, "run").mockImplementation(async () => {
      runner.emit("agent_start", new framework.RunContext(), state.agent as never);
      const model = await integration.modelProvider.getModel();
      const iterator = model.getStreamedResponse({} as Agents.ModelRequest)[Symbol.asyncIterator]();
      await iterator.next();
      consumerFrames.push(getCurrentRun()?.agentRunId);
      if (mode === "return") await iterator.return?.();
      else if (mode === "throw") await expect(iterator.throw?.(error)).rejects.toBe(error);
      else await iterator.next();
      consumerFrames.push(getCurrentRun()?.agentRunId);
      return {} as never;
    });
    try {
      await integration.run(runner, state.agent, "Synthetic input.", { workflow: "workflow" });
      expect(new Set(frames).size).toBe(1);
      expect(frames[0]).toMatch(/^run_/);
      expect(consumerFrames[0]).not.toBe(frames[0]);
      expect(consumerFrames[1]).toBe(consumerFrames[0]);
      expect(getCurrentRun()).toBeUndefined();
    } finally {
      await state.client.close();
    }
  });

  it("preserves a provider decision when iterator cleanup also throws", async () => {
    const state = setup();
    const delegate = new framework.OpenAIChatCompletionsModel(state.raw, "gpt-4.1-mini");
    const decision = new SolwynError("synthetic decision");
    vi.spyOn(delegate, "getStreamedResponse").mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw decision;
          },
          return: async () => {
            throw new Error("synthetic cleanup failure");
          },
        };
      },
    });
    class ProbeProvider extends framework.OpenAIProvider {
      override async getModel() {
        return delegate;
      }
    }
    const integration = new SolwynAgents({ client: state.client, OpenAIProvider: ProbeProvider });
    const runner = new framework.Runner({
      modelProvider: integration.modelProvider,
      tracingDisabled: true,
    });
    vi.spyOn(runner, "run").mockImplementation(async () => {
      runner.emit("agent_start", new framework.RunContext(), state.agent as never);
      const model = await integration.modelProvider.getModel();
      for await (const _event of model.getStreamedResponse({} as Agents.ModelRequest)) {
        /* drain */
      }
      return {} as never;
    });
    try {
      await expect(
        integration.run(runner, state.agent, "Synthetic input.", { workflow: "workflow" }),
      ).rejects.toBe(decision);
    } finally {
      await state.client.close();
    }
  });

  it("does not create unhandled rejections when only a failed stream is consumed", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    const state = setup();
    state.agent.model = "solwyn-test/deny";
    try {
      const result = await state.integration.runStreamed(
        state.runner,
        state.agent,
        "Synthetic input.",
        { workflow: "workflow", tags: { team: "support" } },
      );
      await expect(
        (async () => {
          for await (const _event of result) {
            /* drain */
          }
        })(),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await state.client.close();
    }
  });
});

describe("solwynToolErrorFunction", () => {
  it("pins the native default message for ordinary errors", async () => {
    const native = framework.tool({
      name: "synthetic_failure",
      description: "Synthetic failure",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: () => {
        throw new Error("synthetic failure");
      },
    });
    const message = await native.invoke(new framework.RunContext(), "{}");
    expect(message).toBe("An error occurred while running the tool. Please try again.");
    expect(solwynToolErrorFunction(undefined, new Error("synthetic failure"))).toBe(message);
  });
  it("rethrows branded decisions through causes and terminates on cycles", () => {
    const decision = new SolwynError("synthetic decision");
    expect(() =>
      solwynToolErrorFunction(undefined, new Error("outer", { cause: decision })),
    ).toThrow(decision);
    const cyclic = new Error("synthetic failure");
    cyclic.cause = cyclic;
    expect(solwynToolErrorFunction(undefined, cyclic)).toBe(
      "An error occurred while running the tool. Please try again.",
    );
    expect(solwynToolErrorFunction(undefined, { name: "SolwynError" })).toBe(
      "An error occurred while running the tool. Please try again.",
    );
  });
});
