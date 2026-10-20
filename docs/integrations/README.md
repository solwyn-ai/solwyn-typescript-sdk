# Framework integrations

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#framework-integrations).

Solwyn separates framework attribution from provider enforcement. Integration modules consume
structural lifecycle data only and pass the privacy firewall. They do not read model content,
check budgets, or settle usage. Enforcement requires the wrapped provider-client boundary in the
exact linked recipe. Framework telemetry is separate: LangSmith tracing can export content to
LangSmith even though Solwyn never sends prompt/response content to Solwyn Cloud.

| Framework | Enforcement | Attribution | Hierarchy | Admitted and tested calls | Install and dependency posture | Churn posture |
|---|---|---|---|---|---|---|
| [LangChain.js and LangGraph.js](langchain.md) | Through the recipe's Solwyn-wrapped OpenAI `chat.completions.create` only. | `SolwynRunScopeHandler` binds a per-model signal key to a detached scope. | Lazy root scope; stable graph-node scopes reused across iterations and nested by enclosing node scope; tool/retriever edges are transparent. Stops target leaf run IDs. | Chain `invoke`/`stream`; compiled graph `invoke`/`stream` with values/updates/messages, parallel nodes, model concurrency limits, loops, function-tool binding, denials, and stream stops. See the page for refusals and exclusions. | Node 22+. Optional `@langchain/core >=1.2.14 <2`; install `openai`, `@langchain/openai`, and `@langchain/langgraph` for the recipe. All entries load with no framework/provider peers installed. | Locked core 1.2.18, OpenAI integration 1.6.2, LangGraph 1.5.1; weekly/manual latest-framework canary. The version-sensitive subclass stays in docs/tests. |
| CrewAI | Not available: no official TypeScript SDK | — | — | — | — | — |

CrewAI is Python-only. Its [official JavaScript route](https://docs.crewai.com/en/api-reference/introduction)
is a REST API for hosted crews: their model calls run off-process, so there is no in-process
provider client for this SDK to wrap. Community ports are outside this support matrix.

These are tested recipes, not blanket coverage of every framework surface. Keep the wrapped
client, handler, compatibility subclass, and admitted call shape together. The integration entry
loads in an edge bundle, but attribution requires `@solwyn/sdk/node`; construction fails loudly
without it. A wrapped provider client used directly remains available for edge enforcement.
