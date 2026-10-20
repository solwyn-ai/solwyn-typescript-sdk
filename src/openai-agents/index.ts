import type {
  Agent,
  AgentInputItem,
  Model,
  ModelProvider,
  ModelRequest,
  OpenAIProvider as NativeOpenAIProvider,
  NonStreamRunOptions,
  Runner,
  RunResult,
  RunStreamEvent,
  StreamEvent,
  StreamedRunResult,
} from "@openai/agents";
import { ConfigurationError, SolwynError } from "../errors";
import { requireDetachedRunFactory, requireSolwynClient } from "../integration-support";
import {
  type DetachedRun,
  type DetachedRunFactory,
  getCurrentRun,
  runOutsideRun,
} from "../run-context";

export interface SolwynAgentsOptions {
  readonly client: object;
  /** Pass the OpenAIProvider class exported by @openai/agents. */
  readonly OpenAIProvider: typeof NativeOpenAIProvider;
  /** Defaults to Chat Completions. Both admitted transports use HTTP. */
  readonly api?: "chat_completions" | "responses";
}

// Match the native Runner's context/output generics, including typed function tools.
// biome-ignore lint/suspicious/noExplicitAny: native Agent is invariant in its context and output types.
type AnyAgent = Agent<any, any>;

export interface SolwynAgentsRunOptions<TContext = undefined, TAgent extends AnyAgent = AnyAgent> {
  readonly workflow: string;
  readonly tags?: Record<string, string>;
  readonly runOptions?: Omit<NonStreamRunOptions<TContext, TAgent>, "stream">;
}

function violation(message: string): SolwynError {
  return new SolwynError(`openai-agents: ${message}`);
}

/**
 * Agents' ToolCallError (tools and their input/output guardrails) and
 * GuardrailExecutionError (agent input/output guardrails) have own error/state fields.
 * Unwrap only an immediate branded Solwyn decision. Ordinary failures and tripwires
 * stay wrapped; tripwire classes carry result instead of error. State stays opaque.
 */
function unwrapToolDecision(error: unknown): unknown {
  try {
    // Agents' own error/state fields survive class-name minification; state stays opaque.
    if (
      error instanceof Error &&
      "error" in error &&
      Object.hasOwn(error, "error") &&
      Object.hasOwn(error, "state")
    ) {
      if (error.error instanceof SolwynError) return error.error;
    }
  } catch {
    // A foreign error's accessor must not replace the original failure.
  }
  return error;
}

/** One logical invocation; handles stay stable across tool turns and hand-backs. */
class Invocation {
  readonly #workflow: DetachedRun;
  readonly #factory: DetachedRunFactory;
  readonly #register: (runId: string) => void;
  readonly #remove: (runId: string) => void;
  readonly #handles = new Map<object, DetachedRun>();
  readonly #tools = new Map<object, number>();
  #current: DetachedRun | undefined;
  #agent: object | undefined;
  #attempts = 0;
  #closing = false;
  #violation: SolwynError | undefined;

  constructor(
    workflow: DetachedRun,
    factory: DetachedRunFactory,
    register: (runId: string) => void,
    remove: (runId: string) => void,
  ) {
    this.#workflow = workflow;
    this.#factory = factory;
    this.#register = register;
    this.#remove = remove;
  }

  fail(message: string): never {
    this.#violation ??= violation(message);
    throw this.#violation;
  }

  check(): void {
    if (this.#violation !== undefined) throw this.#violation;
    if (this.#closing) this.fail("workflow has closed");
  }

  failure(error: unknown): unknown {
    return this.#violation ?? unwrapToolDecision(error);
  }

  start(agent: AnyAgent): void {
    this.check();
    if (this.#current !== undefined || this.#attempts !== 0) {
      this.fail("overlapping agent_start is not admitted");
    }
    if (agent.model !== undefined && typeof agent.model !== "string") {
      this.fail("Agent.model must be a string; Model instances bypass attribution");
    }
    const name = agent.name;
    // The prefix and name together must fit createRun's 255 UTF-16-unit bound.
    // Unicode mode rejects lone surrogates while accepting complete astral code points.
    if (
      typeof name !== "string" ||
      name.length > 249 ||
      !/^(?=[\s\S]*\S)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]+$/u.test(name)
    ) {
      this.fail("invalid agent name");
    }
    let handle = this.#handles.get(agent);
    if (handle === undefined) {
      handle = runOutsideRun(() => this.#workflow.activate(() => this.#factory(`agent:${name}`)));
      this.#handles.set(agent, handle);
      this.#register(handle.runId);
    }
    this.#current = handle;
    this.#agent = agent;
  }

  end(agent: object): void {
    this.check();
    if (agent !== this.#agent || this.#attempts !== 0) {
      this.fail("agent end or handoff does not match the active agent");
    }
    this.#current = undefined;
    this.#agent = undefined;
  }

  toolStart(agent: object, tool: object): void {
    this.check();
    if (agent !== this.#agent) this.fail("tool has no matching active agent");
    this.#tools.set(tool, (this.#tools.get(tool) ?? 0) + 1);
  }

  toolEnd(agent: object, tool: object): void {
    this.check();
    if (agent !== this.#agent) this.fail("unmatched tool end");
    const count = this.#tools.get(tool);
    // Agents also emits tool_end when an input guardrail fails before tool_start.
    if (count === undefined) return;
    if (count === 1) this.#tools.delete(tool);
    else this.#tools.set(tool, count - 1);
  }

  beginAttempt(): Attempt {
    this.check();
    if (this.#tools.size !== 0)
      this.fail("model call inside a tool (nested agent run) is not admitted");
    if (this.#current === undefined) this.fail("model call has no active agent");
    if (this.#attempts !== 0) this.fail("concurrent model attempts are not admitted");
    this.#attempts += 1;
    return new Attempt(
      this.#current,
      () => {
        this.#attempts -= 1;
        if (this.#closing) this.close();
      },
      (message) => this.fail(message),
    );
  }

  /** Never finish an active handle. Attempt completion retries deferred cleanup. */
  close(): void {
    this.#closing = true;
    this.#current = undefined;
    this.#agent = undefined;
    this.#tools.clear();
    let finished = true;
    for (const handle of this.#handles.values()) {
      if (!handle.tryFinish()) finished = false;
    }
    if (!this.#workflow.tryFinish()) finished = false;
    if (!finished) return;
    for (const handle of this.#handles.values()) this.#remove(handle.runId);
    this.#handles.clear();
    this.#remove(this.#workflow.runId);
  }
}

class Attempt {
  readonly #handle: DetachedRun;
  readonly #release: () => void;
  readonly #fail: (message: string) => never;
  #finished = false;

  constructor(handle: DetachedRun, release: () => void, fail: (message: string) => never) {
    this.#handle = handle;
    this.#release = release;
    this.#fail = fail;
  }

  activate<T>(fn: () => T): T {
    return runOutsideRun(() => this.#handle.activate(fn));
  }

  fail(message: string): never {
    return this.#fail(message);
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#release();
  }
}

/** Activates only provider operations, never the consumer's time between pulls. */
class ActivatedStream implements AsyncIterableIterator<StreamEvent> {
  readonly #attempt: Attempt;
  readonly #iterator: AsyncIterator<StreamEvent>;
  #finished = false;
  #pulling = false;

  constructor(attempt: Attempt, create: () => AsyncIterable<StreamEvent>) {
    this.#attempt = attempt;
    try {
      this.#iterator = attempt.activate(() => create()[Symbol.asyncIterator]());
    } catch (error) {
      attempt.finish();
      throw error;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent> {
    return this;
  }

  async #pull(
    fn: () => Promise<IteratorResult<StreamEvent>>,
  ): Promise<IteratorResult<StreamEvent>> {
    if (this.#pulling) this.#attempt.fail("concurrent stream pulls are not admitted");
    this.#pulling = true;
    try {
      const step = await this.#attempt.activate(fn);
      if (step.done) this.#finish();
      return step;
    } catch (error) {
      try {
        await this.#attempt.activate(() => this.#iterator.return?.());
      } catch {
        // Cleanup must not replace the original provider or Solwyn decision.
      } finally {
        this.#finish();
      }
      throw error;
    } finally {
      this.#pulling = false;
    }
  }

  #finish(): void {
    this.#finished = true;
    this.#attempt.finish();
  }

  next(): Promise<IteratorResult<StreamEvent>> {
    if (this.#finished) return Promise.resolve({ done: true, value: undefined });
    return this.#pull(() => this.#iterator.next());
  }

  async return(): Promise<IteratorResult<StreamEvent>> {
    if (this.#finished) return { done: true, value: undefined };
    try {
      return await this.#pull(async () =>
        this.#iterator.return === undefined
          ? { done: true, value: undefined }
          : this.#iterator.return(),
      );
    } finally {
      this.#finish();
    }
  }

  async throw(error: unknown): Promise<IteratorResult<StreamEvent>> {
    if (this.#finished) throw error;
    const forwardThrow = this.#iterator.throw?.bind(this.#iterator);
    if (forwardThrow === undefined) {
      await this.return();
      throw error;
    }
    return this.#pull(() => forwardThrow(error));
  }
}

class SolwynModel implements Model {
  readonly #delegate: Model;
  readonly #state: () => Invocation;

  constructor(delegate: Model, state: () => Invocation) {
    this.#delegate = delegate;
    this.#state = state;
  }

  get supportsPromptModelSelection(): boolean | undefined {
    return this.#delegate.supportsPromptModelSelection;
  }

  async getResponse(opaqueRequest: ModelRequest) {
    const attempt = this.#state().beginAttempt();
    try {
      return await attempt.activate(() => this.#delegate.getResponse(opaqueRequest));
    } finally {
      attempt.finish();
    }
  }

  getStreamedResponse(opaqueRequest: ModelRequest): AsyncIterableIterator<StreamEvent> {
    return new ActivatedStream(this.#state().beginAttempt(), () =>
      this.#delegate.getStreamedResponse(opaqueRequest),
    );
  }

  getRetryAdvice(args: Parameters<NonNullable<Model["getRetryAdvice"]>>[0]) {
    if (args.error instanceof SolwynError) {
      return { suggested: false, replaySafety: "unsafe" as const, reason: "solwyn_decision" };
    }
    return this.#delegate.getRetryAdvice?.(args);
  }
}

/** Forward cancellation even before the first pull; check the latch at stream termination. */
class CompletedStream implements AsyncIterableIterator<RunStreamEvent> {
  readonly #iterator: AsyncIterator<RunStreamEvent>;
  readonly #completed: Promise<void>;
  readonly #onReturn: () => void;

  constructor(
    iterator: AsyncIterator<RunStreamEvent>,
    completed: Promise<void>,
    onReturn: () => void,
  ) {
    this.#iterator = iterator;
    this.#completed = completed;
    this.#onReturn = onReturn;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<RunStreamEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<RunStreamEvent>> {
    try {
      const step = await this.#iterator.next();
      if (step.done) await this.#completed;
      return step;
    } catch (error) {
      await this.#completed;
      throw unwrapToolDecision(error);
    }
  }

  async return(): Promise<IteratorResult<RunStreamEvent>> {
    try {
      return (await this.#iterator.return?.()) ?? { done: true, value: undefined };
    } catch (error) {
      throw unwrapToolDecision(error);
    } finally {
      // Cancellation need not wait for a provider ignoring its abort signal.
      // The completed observer owns cleanup once native background work settles.
      this.#onReturn();
    }
  }

  async throw(error: unknown): Promise<IteratorResult<RunStreamEvent>> {
    if (this.#iterator.throw === undefined) {
      await this.return();
      throw error;
    }
    try {
      const step = await this.#iterator.throw(error);
      if (step.done) await this.#completed;
      return step;
    } catch (caught) {
      await this.#completed;
      throw unwrapToolDecision(caught);
    }
  }
}

/** Workflow and per-agent attribution over an explicitly wrapped OpenAI HTTP client. */
export class SolwynAgents {
  readonly modelProvider: ModelProvider;
  readonly #factory: DetachedRunFactory;
  readonly #attached = new WeakSet<Runner>();
  private readonly invocations = new Map<string, Invocation>();

  constructor(options: SolwynAgentsOptions) {
    this.#factory = requireDetachedRunFactory("openai-agents");
    requireSolwynClient(options.client, "openai-agents");
    if (
      options.api !== undefined &&
      options.api !== "chat_completions" &&
      options.api !== "responses"
    ) {
      throw new ConfigurationError("openai-agents: api must be chat_completions or responses", {
        field: "api",
      });
    }
    if (
      typeof options.OpenAIProvider !== "function" ||
      typeof options.OpenAIProvider.prototype !== "object" ||
      options.OpenAIProvider.prototype === null
    ) {
      throw new ConfigurationError("openai-agents: OpenAIProvider must be a constructor", {
        field: "OpenAIProvider",
      });
    }
    const delegate = new options.OpenAIProvider({
      openAIClient: options.client as NonNullable<
        ConstructorParameters<typeof NativeOpenAIProvider>[0]
      >["openAIClient"],
      useResponses: options.api === "responses",
      // Override the framework's global websocket default. Websockets bypass the wrapped client.
      useResponsesWebSocket: false,
    });
    if (typeof delegate.getModel !== "function") {
      throw new ConfigurationError("openai-agents: OpenAIProvider must supply getModel", {
        field: "OpenAIProvider",
      });
    }
    this.modelProvider = {
      getModel: async (name?: string) => {
        const model = await delegate.getModel(name);
        if (typeof model !== "object" || model === null) {
          throw violation("delegate returned an unknown model");
        }
        // Admit the direct HTTP model prototypes produced by the controlled provider.
        // WS models inherit the Responses prototype; plain/custom model objects are not admitted.
        // Public method topology survives class-name minification.
        const prototype: object | null = Object.getPrototypeOf(model);
        if (
          prototype === null ||
          Object.getPrototypeOf(prototype) !== Object.prototype ||
          !Object.hasOwn(prototype, "getResponse") ||
          !Object.hasOwn(prototype, "getStreamedResponse") ||
          !Object.hasOwn(prototype, "getRetryAdvice") ||
          typeof model.getResponse !== "function" ||
          typeof model.getStreamedResponse !== "function" ||
          typeof model.getRetryAdvice !== "function"
        ) {
          throw violation(
            "only the OpenAIProvider Chat Completions and Responses HTTP models are admitted",
          );
        }
        return new SolwynModel(model, () => this.#requireState());
      },
    };
  }

  #state(): Invocation | undefined {
    const frame = getCurrentRun();
    if (frame === undefined) return undefined;
    return (
      this.invocations.get(frame.agentRunId) ??
      (frame.parentAgentRunId == null ? undefined : this.invocations.get(frame.parentAgentRunId))
    );
  }

  #requireState(): Invocation {
    const state = this.#state();
    if (state === undefined) throw violation("model used outside a SolwynAgents workflow");
    state.check();
    return state;
  }

  attach(runner: Runner): void {
    if (runner.config.modelProvider !== this.modelProvider)
      throw violation("runner uses a foreign modelProvider");
    if (runner.config.model !== undefined && typeof runner.config.model !== "string") {
      throw violation("runner.config.model must be a string");
    }
    if (this.#attached.has(runner)) return;
    runner.on("agent_start", (_context, agent) => this.#state()?.start(agent));
    runner.on("agent_handoff", (_context, fromAgent) => this.#state()?.end(fromAgent));
    runner.on("agent_end", (_context, agent) => this.#state()?.end(agent));
    runner.on("agent_tool_start", (_context, agent, tool) => this.#state()?.toolStart(agent, tool));
    runner.on("agent_tool_end", (_context, agent, tool) => this.#state()?.toolEnd(agent, tool));
    this.#attached.add(runner);
  }

  #open(workflow: DetachedRun): Invocation {
    const state = new Invocation(
      workflow,
      this.#factory,
      (runId) => this.invocations.set(runId, state),
      (runId) => {
        this.invocations.delete(runId);
      },
    );
    this.invocations.set(workflow.runId, state);
    return state;
  }

  #validateInput(opaqueRunInput: unknown): void {
    if (typeof opaqueRunInput !== "string" && !Array.isArray(opaqueRunInput)) {
      throw violation("RunState resume and non-input objects are not admitted");
    }
  }

  async run<TAgent extends AnyAgent, TContext = undefined>(
    runner: Runner,
    agent: TAgent,
    opaqueRunInput: string | AgentInputItem[],
    options: SolwynAgentsRunOptions<TContext, TAgent>,
  ): Promise<RunResult<TContext, TAgent>> {
    this.attach(runner);
    this.#state()?.fail("nested integration workflows are not admitted");
    this.#validateInput(opaqueRunInput);
    const workflow = this.#factory(options.workflow, { tags: options.tags });
    const state = this.#open(workflow);
    const opaqueOptions = options.runOptions;
    try {
      const opaqueResult = await workflow.activate(() =>
        runner.run<TAgent, TContext>(agent, opaqueRunInput, { ...opaqueOptions, stream: false }),
      );
      state.check();
      return opaqueResult;
    } catch (error) {
      throw state.failure(error);
    } finally {
      state.close();
    }
  }

  async runStreamed<TAgent extends AnyAgent, TContext = undefined>(
    runner: Runner,
    agent: TAgent,
    opaqueRunInput: string | AgentInputItem[],
    options: SolwynAgentsRunOptions<TContext, TAgent>,
  ): Promise<StreamedRunResult<TContext, TAgent>> {
    this.attach(runner);
    this.#state()?.fail("nested integration workflows are not admitted");
    this.#validateInput(opaqueRunInput);
    const workflow = this.#factory(options.workflow, { tags: options.tags });
    const state = this.#open(workflow);
    const opaqueOptions = options.runOptions;
    try {
      const result = await workflow.activate(() =>
        runner.run<TAgent, TContext>(agent, opaqueRunInput, { ...opaqueOptions, stream: true }),
      );
      const completed = result.completed
        .then(
          () => {
            const error = state.failure(undefined);
            if (error !== undefined) throw error;
          },
          (error: unknown) => {
            throw state.failure(error);
          },
        )
        .finally(() => state.close());
      // Cleanup and decisions must never become unhandled if the caller only iterates.
      void completed.then(
        () => undefined,
        () => undefined,
      );
      const iterate = result[Symbol.asyncIterator].bind(result);
      Object.defineProperty(result, "completed", { value: completed });
      Object.defineProperty(result, Symbol.asyncIterator, {
        value: () =>
          new CompletedStream(iterate(), completed, () => {
            const error = state.failure(undefined);
            if (error !== undefined) throw error;
          }),
      });
      return result;
    } catch (error) {
      state.close();
      throw state.failure(error);
    }
  }
}

/** Preserve Solwyn decisions while matching Agents' ordinary tool-error fallback. */
export function solwynToolErrorFunction(_context: unknown, error: unknown): string {
  const seen = new Set<object>();
  for (let depth = 0; depth < 32; depth += 1) {
    if (error instanceof SolwynError) throw error;
    if (typeof error !== "object" || error === null || seen.has(error)) break;
    seen.add(error);
    try {
      error = "cause" in error ? error.cause : undefined;
    } catch {
      break;
    }
  }
  return "An error occurred while running the tool. Please try again.";
}
