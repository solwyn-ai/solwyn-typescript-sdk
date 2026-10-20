# LangChain.js and LangGraph.js

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#framework-integrations).

`@solwyn/sdk/langchain` supplies `SolwynRunScopeHandler`, a content-free attribution handler.
Budget enforcement and settlement happen only when a provider call crosses the Solwyn-wrapped
client. The handler reads structural run IDs, parent IDs, explicit names, cancellation signals,
and `metadata.langgraph_node`; it never reads model input, output, tool arguments, or usage.
Do not wrap a `ChatOpenAI` instance with `Solwyn`: wrap its OpenAI client as below.

Use Node.js 22 or newer. Install `@solwyn/sdk`, `openai`, `@langchain/core`,
`@langchain/openai`, and `@langchain/langgraph`. The optional peer is
`@langchain/core >=1.2.14 <2`: 1.2.14 honors LangChain's retryability symbol and satisfies
`@langchain/openai@1.6.2`'s core requirement. The locked tests use core **1.2.18**, OpenAI
integration **1.6.2**, LangGraph **1.5.1**, and OpenAI **7.36.0**. Declaration consumers use
TypeScript **5.8.3** and **6.0.3**, with `skipLibCheck: false` and `@types/node` **22.15.30**.
TypeScript 5.7 is outside this integration's tested floor because of upstream declarations.

## Exact Chat Completions recipe

Keep the handler, subclass, refusing Responses implementation, and refusing fetch together.
The Responses refusal runs before LangChain's retry caller; `configuration.fetch` is a backstop
for any separately constructed client. `useResponsesApi: false` alone cannot prevent automatic
Responses selection for every model/feature. Leave `onFailedAttempt` unset: replacing it removes
LangChain's default classification of 401 and other non-retryable provider errors.

```ts
import OpenAI from "openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI, ChatOpenAICompletions, ChatOpenAIResponses } from "@langchain/openai";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { Solwyn, SolwynError } from "@solwyn/sdk/node";
import { SolwynRunScopeHandler } from "@solwyn/sdk/langchain";

const handler = new SolwynRunScopeHandler();
const solwyn = new Solwyn(new OpenAI({ maxRetries: 0 }), {
  apiKey: process.env.SOLWYN_API_KEY!,
});
const leaf = handler.chatCompletionsLeaf(solwyn);

class SolwynChatCompletions extends ChatOpenAICompletions {
  constructor(fields: ConstructorParameters<typeof ChatOpenAICompletions>[0]) {
    super(fields);
    this.client = leaf as typeof this.client;
  }
  override _generate(
    ...[opaque, options, manager]: Parameters<ChatOpenAICompletions["_generate"]>
  ) {
    return super._generate(opaque, handler.bindModelCall(options, manager), manager);
  }
  override _streamResponseChunks(
    ...[opaque, options, manager]: Parameters<ChatOpenAICompletions["_streamResponseChunks"]>
  ) {
    return super._streamResponseChunks(opaque, handler.bindModelCall(options, manager), manager);
  }
  override async *_streamChatModelEvents(): AsyncGenerator<never> {
    throw new SolwynError("LangChain chat-model stream events are not admitted");
  }
}
class RefuseResponses extends ChatOpenAIResponses {
  override async _generate(): Promise<never> {
    throw new SolwynError("LangChain Responses API is not admitted");
  }
  override async *_streamResponseChunks(): AsyncGenerator<never> {
    throw new SolwynError("LangChain Responses API is not admitted");
  }
  override async *_streamChatModelEvents(): AsyncGenerator<never> {
    throw new SolwynError("LangChain Responses API is not admitted");
  }
}
const fields = {
  model: "gpt-4.1-mini",
  apiKey: "unused-by-metered-path",
  useResponsesApi: false,
  maxRetries: 0,
  configuration: {
    fetch: () => Promise.reject(new SolwynError("Unmetered LangChain client refused")),
  },
};
const model = new ChatOpenAI({
  ...fields,
  completions: new SolwynChatCompletions(fields),
  responses: new RefuseResponses(fields),
});
const prompt = ChatPromptTemplate.fromTemplate("Answer this synthetic request: {question}");
const chain = prompt.pipe(model).withConfig({ runName: "support-chain", callbacks: [handler] });
const State = Annotation.Root({ done: Annotation<boolean>() });
const graph = new StateGraph(State)
  .addNode("answer", async () => {
    await model.invoke("Synthetic graph request");
    return { done: true };
  })
  .addEdge(START, "answer")
  .addEdge("answer", END)
  .compile()
  .withConfig({ runName: "support-graph", callbacks: [handler] });
try {
  await chain.invoke({ question: "fixture" });
  for await (const _ of await chain.stream({ question: "fixture" })) { /* consume */ }
  await graph.invoke({});
} finally {
  await solwyn.close();
}
```

The cast assigns a content-blind client capability to an upstream internal field. It does not
validate arbitrary LangChain call paths. A raw OpenAI client is rejected at leaf construction.
LangChain must propagate this handler to each model run. Calling the model directly without a
parent chain fails closed. Do not replace `options.options.signal`: it overrides the per-call
key on LangChain's non-streaming path and the leaf refuses dispatch. Cancellation propagates
the upstream signal's reason, and model-end/error callbacks remove its listener.

## Admitted and tested

- Non-structured Chat Completions through chain `invoke` and `stream`.
- Compiled LangGraph `invoke` and `stream` with `streamMode: "values"`, `"updates"`, or
  `"messages"`, including parallel nodes, model `maxConcurrency: 1`, concurrent calls within a node,
  and repeated node iterations.
- `bindTools` with function tools that make no model calls, and `withConfig`.
- Budget denial, default retry veto on Solwyn errors, native provider retry classification,
  and cooperative exact-run stop at the next provider-chunk boundary.

## Not admitted

- Responses API, including explicit selection and automatic switching: typed refusal before
  dispatch. JSON-schema structured output uses `chat.completions.parse`, which is refused.
- `_streamChatModelEvents`, LangGraph v3 messages streaming, and `streamEvents` (including v2).
- Early stream `break`/iterator `return()`: core 1.2.18 can omit the root's terminal callback,
  retaining handler scopes. Consume streams fully, or abort with the call's `AbortSignal` and
  continue iteration until the cancellation error so terminal callbacks run.
- `generate`/`batch`, `__includeRawResponse`, Azure, `@langchain/langgraph/web`, ChatAnthropic,
  and other provider integrations.
- Parallel graph fan-out with graph-level `maxConcurrency: 1`: LangGraph 1.5.1 can omit
  pending tasks. The queue bound tested here is the model's `maxConcurrency`; a separate
  sequential-node graph is tested with graph-level `maxConcurrency: 1`.
- Model calls inside tools or retrievers are outside the tested recipe. Their lifecycle IDs
  are transparent hierarchy edges, so a model using the leaf can resolve its scope; an unbound
  model ends with a post-hoc error. Tool frameworks may turn thrown errors into tool results.
- Edge attribution. The entry can load without Node or framework packages, but constructing the
  handler without importing `@solwyn/sdk/node` throws `ConfigurationError`. Edge applications
  can use a wrapped provider client directly for enforcement without framework attribution.

A model that ends without binding this handler's leaf raises `SolwynError`: the call was not
metered. This diagnostic happens after the call and cannot undo provider work. It is a guard
against accidental bypass, not an admission of arbitrary models or cache configurations.

## Scopes, tags, and tracing

Ordinary chains attribute model calls to a lazily created root scope. LangGraph nodes reuse a
scope per root, enclosing node scope, and node name across iterations. Nested node scopes are
children; tools and retrievers add no Solwyn runs. Scopes finish when the root ends, deferring
active work until its activation settles. Missing terminal framework callbacks can retain
handler state; use well-behaved runnables and consume streams through completion or cancellation
errors as described above.

Under an outer `run(...)`, the root is its child. Calls carry the leaf scope's exact run ID;
Cloud stops and per-run controls must target that leaf ID. Stopping a parent does not stop its
children. Stable node IDs preserve lease reuse and velocity history across loop iterations.
Scope names (`runName`, node names, and `namePrefix`) must contain only non-sensitive attribution.
Names replace controls, format characters, line/paragraph separators, and lone surrogates, and
clamp without splitting Unicode code points, within the Node run-name limit of 255 UTF-16 units.

`new SolwynRunScopeHandler({ tags: { workflow: "support" } })` applies explicit tags at the root;
children inherit them. Tags are sent verbatim, must be non-sensitive, and make calls ineligible
for token leases so tag-scoped policy remains authoritative. LangChain's own callback tags are
not inferred or copied to Solwyn.

LangSmith tracing exports prompt/response content to **LangSmith**, outside Solwyn's privacy
boundary. Keep `LANGSMITH_TRACING` and `LANGCHAIN_TRACING_V2` off unless that export is intended.
The SDK never enables LangSmith tracing.

This is a version-sensitive recipe: it depends on the completions `client` field, signal
forwarding, and callback runtime order. Locked offline tests compile and execute this example;
a weekly/manual latest-framework canary checks churn. A passing tested version does not imply
coverage of every intervening release or framework surface. Upgrade these packages together
and rerun the recipe tests before deploying.
