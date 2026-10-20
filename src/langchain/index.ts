import { ConfigurationError, SolwynError } from "../errors";
import { requireDetachedRunFactory, requireSolwynClient } from "../integration-support";
import { consoleLogger } from "../logging";
import { type DetachedRun, type DetachedRunFactory, runOutsideRun } from "../run-context";
import { copyTags } from "../tags";

export interface SolwynRunScopeHandlerOptions {
  /** Non-sensitive attribution prefix. Defaults to `langchain`. */
  readonly namePrefix?: string;
  /** Explicit, non-sensitive attribution only. Tagged calls cannot use token leases. */
  readonly tags?: Record<string, string>;
}

interface RunManagerLike {
  readonly runId: string;
  readonly handlers: readonly unknown[];
}
interface SignalOptions {
  readonly signal?: AbortSignal;
}
interface ChatClient {
  readonly chat: {
    readonly completions: {
      create(opaqueRequest: unknown, opaqueOptions: SignalOptions): unknown;
    };
  };
}
interface Scope {
  readonly rootRunId: string;
  readonly nodeName?: string;
  readonly scopeName: string;
  readonly parentScope?: Scope;
  readonly nodeScopes: Map<string, Scope>;
  handle?: DetachedRun;
}
interface Root {
  readonly scopes: Set<Scope>;
  closed: boolean;
}
interface StructuralRun {
  readonly rootRunId: string;
  readonly scope: Scope;
}
interface ModelRun extends StructuralRun {
  bound: boolean;
  readonly bindings: Map<AbortSignal, () => void>;
}

function nonRetryable(failure: unknown): unknown {
  if (failure instanceof SolwynError) {
    Object.defineProperty(failure, Symbol.for("langchain.errors.retryable"), {
      value: false,
      configurable: true,
    });
  }
  return failure;
}
function refusal(detail: string): never {
  throw nonRetryable(new SolwynError(detail));
}
function scopeName(prefix: string, name: string): string {
  let sanitized = "";
  for (const character of `${prefix}:${name}`) {
    const safe = /[\p{Cc}\p{Cs}]/u.test(character) ? "_" : character;
    if (sanitized.length + safe.length > 255) break;
    sanitized += safe;
  }
  return sanitized;
}
function signalOf(options: SignalOptions | undefined): AbortSignal | undefined {
  return options?.signal;
}

/**
 * Structural LangChain/LangGraph attribution for the documented Chat Completions recipe.
 * The wrapped provider client owns all enforcement and settlement. Import
 * `@solwyn/sdk/node` before construction to install Node run attribution.
 */
export class SolwynRunScopeHandler {
  readonly name = "solwyn_run_scope";
  readonly awaitHandlers = true;
  readonly raiseError = true;
  readonly ignoreLLM = false;
  readonly ignoreChain = false;
  // LangChain gates tool callbacks behind ignoreAgent as well. Agent content callbacks
  // remain absent; tool lifecycle callbacks are transparent structural edges.
  readonly ignoreAgent = false;
  readonly ignoreRetriever = false;
  readonly ignoreCustomEvent = true;

  private readonly factory: DetachedRunFactory;
  private readonly prefix: string;
  private readonly tags: Record<string, string> | undefined;
  private readonly runs = new Map<string, StructuralRun>();
  private readonly models = new Map<string, ModelRun>();
  private readonly roots = new Map<string, Root>();
  private readonly keys = new WeakMap<AbortSignal, Scope>();

  constructor(options: SolwynRunScopeHandlerOptions = {}) {
    this.factory = requireDetachedRunFactory("LangChain");
    const prefix = options.namePrefix ?? "langchain";
    if (typeof prefix !== "string" || prefix.length === 0 || /[\p{Cc}\p{Cs}]/u.test(prefix)) {
      throw new ConfigurationError("namePrefix must be a nonempty, non-sensitive scope prefix", {
        field: null,
      });
    }
    this.prefix = prefix;
    this.tags = copyTags(options.tags, "tags");
  }

  copy(): this {
    return this;
  }

  // Callback runtime order differs from CallbackManager.handleChainStart's own signature.
  handleChainStart(
    _opaqueSerialized: unknown,
    _opaqueInput: unknown,
    runId: string,
    parentRunId?: string,
    _opaqueTags?: unknown,
    metadata?: { readonly langgraph_node?: unknown },
    _opaqueRunType?: unknown,
    runName?: string,
  ): void {
    this.start(runId, parentRunId, runName, metadata?.langgraph_node);
  }

  handleToolStart(
    _opaqueSerialized: unknown,
    _opaqueInput: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.startEdge(runId, parentRunId);
  }

  handleRetrieverStart(
    _opaqueSerialized: unknown,
    _opaqueQuery: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.startEdge(runId, parentRunId);
  }

  handleChainEnd(_opaqueOutput: unknown, runId: string): void {
    this.end(runId);
  }
  handleChainError(_opaqueError: unknown, runId: string): void {
    this.end(runId);
  }
  handleToolEnd(_opaqueOutput: unknown, runId: string): void {
    this.end(runId);
  }
  handleToolError(_opaqueError: unknown, runId: string): void {
    this.end(runId);
  }
  handleRetrieverEnd(_opaqueDocuments: unknown, runId: string): void {
    this.end(runId);
  }
  handleRetrieverError(_opaqueError: unknown, runId: string): void {
    this.end(runId);
  }

  handleChatModelStart(
    _opaqueSerialized: unknown,
    _opaqueInput: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.startModel(runId, parentRunId);
  }
  handleLLMStart(
    _opaqueSerialized: unknown,
    _opaqueInput: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.startModel(runId, parentRunId);
  }
  handleLLMEnd(_opaqueOutput: unknown, runId: string): void {
    this.endModel(runId);
  }
  handleLLMError(_opaqueError: unknown, runId: string): void {
    this.endModel(runId);
  }

  /** Forward call options unchanged apart from a fresh, linked per-model signal key. */
  bindModelCall<O extends SignalOptions>(opaqueCallOptions: O, runManager: unknown): O {
    if (typeof runManager !== "object" || runManager === null) {
      return refusal("LangChain model call requires its run manager");
    }
    const manager = runManager as RunManagerLike;
    const model = this.models.get(manager.runId);
    if (
      !Array.isArray(manager.handlers) ||
      !manager.handlers.includes(this) ||
      model === undefined
    ) {
      return refusal("LangChain model call has no matching Solwyn handler and model run");
    }
    const upstream = signalOf(opaqueCallOptions);
    const controller = new AbortController();
    const abort = (): void => controller.abort(upstream?.reason);
    if (upstream?.aborted) abort();
    else upstream?.addEventListener("abort", abort, { once: true });
    const signal = controller.signal;
    model.bindings.set(signal, () => upstream?.removeEventListener("abort", abort));
    this.keys.set(signal, model.scope);
    model.bound = true;
    return { ...opaqueCallOptions, signal };
  }

  /** Only `chat.completions.create` is admitted; every other property fails closed. */
  chatCompletionsLeaf(client: unknown): object {
    requireSolwynClient(client, "LangChain");
    const wrapped = client as ChatClient;
    const create = (opaqueRequest: unknown, opaqueOptions?: SignalOptions): Promise<unknown> => {
      const signal = signalOf(opaqueOptions);
      const scope = signal === undefined ? undefined : this.keys.get(signal);
      if (scope === undefined || this.roots.get(scope.rootRunId)?.closed !== false) {
        return refusal("LangChain call has no bound Solwyn signal key; path is not admitted");
      }
      try {
        const handle = this.materialize(scope);
        const pending = runOutsideRun(() =>
          handle.activate(() =>
            Promise.resolve(
              wrapped.chat.completions.create(opaqueRequest, opaqueOptions as SignalOptions),
            ),
          ),
        );
        return pending.then(
          (opaqueResult) => {
            this.finishClosedRoot(scope.rootRunId);
            return opaqueResult;
          },
          (failure: unknown) => {
            this.finishClosedRoot(scope.rootRunId);
            throw nonRetryable(failure);
          },
        );
      } catch (failure) {
        this.finishClosedRoot(scope.rootRunId);
        throw nonRetryable(failure);
      }
    };
    const completions = new Proxy(
      {},
      {
        get: (_target, member) =>
          member === "create" ? create : refusal("LangChain client member is not admitted"),
      },
    );
    const chat = new Proxy(
      {},
      {
        get: (_target, member) =>
          member === "completions"
            ? completions
            : refusal("LangChain client member is not admitted"),
      },
    );
    return new Proxy(
      {},
      {
        get: (_target, member) =>
          member === "chat" ? chat : refusal("LangChain client member is not admitted"),
      },
    );
  }

  private assertNew(runId: string): void {
    if (this.runs.has(runId) || this.models.has(runId) || this.roots.has(runId))
      refusal("LangChain duplicate run ID");
  }
  private parent(parentRunId: string | undefined): StructuralRun {
    const parent = parentRunId == null ? undefined : this.runs.get(parentRunId);
    if (parent === undefined) return refusal("LangChain run requires a mapped parent chain");
    return parent;
  }
  private start(
    runId: string,
    parentRunId: string | undefined,
    runName?: string,
    nodeName?: unknown,
  ): void {
    this.assertNew(runId);
    if (parentRunId == null) {
      const scope: Scope = {
        rootRunId: runId,
        scopeName: scopeName(
          this.prefix,
          typeof runName === "string" && runName.length > 0 ? runName : "chain",
        ),
        nodeScopes: new Map(),
      };
      this.roots.set(runId, { scopes: new Set([scope]), closed: false });
      this.runs.set(runId, { rootRunId: runId, scope });
      return;
    }
    const parent = this.parent(parentRunId);
    let scope = parent.scope;
    // Descendant chains inherit langgraph_node. A task's explicit runName equals its
    // node name; this also distinguishes a same-named node in a nested subgraph.
    if (typeof nodeName === "string" && (nodeName !== scope.nodeName || runName === nodeName)) {
      let nodeScope = scope.nodeScopes.get(nodeName);
      if (nodeScope === undefined) {
        nodeScope = {
          rootRunId: parent.rootRunId,
          nodeName,
          scopeName: scopeName(this.prefix, nodeName),
          parentScope: scope,
          nodeScopes: new Map(),
        };
        scope.nodeScopes.set(nodeName, nodeScope);
        this.roots.get(parent.rootRunId)?.scopes.add(nodeScope);
      }
      scope = nodeScope;
    }
    this.runs.set(runId, { rootRunId: parent.rootRunId, scope });
  }
  private startEdge(runId: string, parentRunId: string | undefined): void {
    this.assertNew(runId);
    this.runs.set(runId, this.parent(parentRunId));
  }
  private materialize(scope: Scope): DetachedRun {
    if (scope.handle === undefined) {
      if (scope.parentScope === undefined)
        scope.handle = this.factory(scope.scopeName, { tags: this.tags });
      else {
        const parent = this.materialize(scope.parentScope);
        scope.handle = runOutsideRun(() => parent.activate(() => this.factory(scope.scopeName)));
      }
    }
    return scope.handle;
  }
  private startModel(runId: string, parentRunId: string | undefined): void {
    this.assertNew(runId);
    const parent = this.parent(parentRunId);
    this.materialize(parent.scope);
    this.models.set(runId, { ...parent, bound: false, bindings: new Map() });
  }
  private endModel(runId: string): void {
    const model = this.models.get(runId);
    if (model === undefined) return;
    this.models.delete(runId);
    for (const signal of model.bindings.keys()) {
      model.bindings.get(signal)?.();
      this.keys.delete(signal);
    }
    this.finishClosedRoot(model.rootRunId);
    if (!model.bound) refusal("LangChain model call bypassed the Solwyn leaf; it was not metered");
  }
  private end(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    this.runs.delete(runId);
    if (run.rootRunId === runId) {
      const root = this.roots.get(runId);
      if (root === undefined) return;
      root.closed = true;
      for (const childRunId of this.runs.keys()) {
        if (this.runs.get(childRunId)?.rootRunId === runId) this.runs.delete(childRunId);
      }
      this.finishClosedRoot(runId);
    }
  }
  private finishClosedRoot(rootRunId: string): void {
    const root = this.roots.get(rootRunId);
    if (root === undefined || !root.closed) return;
    for (const scope of root.scopes) {
      if (scope.handle === undefined || scope.handle.tryFinish()) root.scopes.delete(scope);
      else {
        const runId = scope.handle.runId;
        try {
          consoleLogger.warn(`LangChain scope finish deferred for run ${runId}`);
        } catch {
          /* cleanup is best effort */
        }
      }
    }
    if (root.scopes.size === 0) this.roots.delete(rootRunId);
  }
}
