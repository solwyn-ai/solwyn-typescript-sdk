# OpenAI Agents SDK

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#framework-integrations).

`@solwyn/sdk/openai-agents` adds workflow and agent attribution to the OpenAI Agents SDK for
JavaScript. Budget admission, usage settlement, and provider enforcement still happen at the
wrapped `Solwyn` client. The integration reads only structural agent names, object identities,
model selection, and lifecycle signals. It never reads prompts, responses, tool arguments, or
tool results, and creates no budget checks or settlement events itself.

Use Node.js 22 or newer. This recipe is tested with `@openai/agents@0.20.0` and `openai@7.36.0`.
Install `@solwyn/sdk`, `openai`, and **`@openai/agents`**. Installing only `@openai/agents-core`
and `@openai/agents-openai` does not supply the public types imported by this entry.

## Complete example

Provide the actual `OpenAIProvider` class and a Solwyn-wrapped OpenAI client. The integration
constructs its delegate with that client and pins HTTP transport. Its default API is Chat
Completions, even if the framework's global API default is Responses.

```ts
import OpenAI from "openai";
import {
  Agent,
  OpenAIProvider,
  Runner,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTracingDisabled,
  tool,
} from "@openai/agents";
import { Solwyn } from "@solwyn/sdk/node";
import { SolwynAgents, solwynToolErrorFunction } from "@solwyn/sdk/openai-agents";

const client = new Solwyn(new OpenAI({ maxRetries: 0 }), { apiKey: process.env.SOLWYN_API_KEY! });
// The proxy preserves OpenAI at runtime; this cast accommodates OpenAI's private-field types.
setDefaultOpenAIClient(client as unknown as OpenAI);
setOpenAIAPI("chat_completions");
setTracingDisabled(true);

const agents = new SolwynAgents({ client, OpenAIProvider });
const runner = new Runner({
  modelProvider: agents.modelProvider,
  tracingDisabled: true,
  traceIncludeSensitiveData: false,
});
agents.attach(runner);

const lookup = tool({
  name: "lookup",
  description: "Look up a non-sensitive support category.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  errorFunction: solwynToolErrorFunction,
  execute: async () => "General support.",
});
const specialist = new Agent({ name: "Specialist", model: "gpt-4.1-mini", tools: [lookup] });
const triageAgent = new Agent({ name: "Triage", model: "gpt-4.1-mini", handoffs: [specialist] });

try {
  const result = await agents.run(runner, triageAgent, "Find a support category.", {
    workflow: "triage-workflow",
    tags: { team: "support" },
    runOptions: { maxTurns: 10 },
  });
  // Use result.finalOutput in your application.
} finally {
  await client.close();
}
```

Your OpenAI client reads `OPENAI_API_KEY`; Solwyn uses `SOLWYN_API_KEY` for the control plane.
Provider traffic goes directly to OpenAI. Setting the
framework's default client also keeps separately configured side runs on a wrapped client;
it does not admit those runs for this integration's attribution.

`runOptions` forwards native non-streaming Runner options. Supply fresh text or input-item arrays;
resuming a `RunState` is refused. `runStreamed` selects streaming internally and returns the
native `StreamedRunResult`, with completion and async iteration observing Solwyn's violation latch.
Consume it with `for await (const event of result) { ... }` and await `result.completed`. Always
consume or cancel a streamed result. Returning its iterator cancels it, including before the first
pull. Abandoned background runs retain attribution until they settle. If using native alternate
views such as `toTextStream()` or `toStream()`, also await `completed` to observe a swallowed
tool-level attribution violation.

## Hierarchy and enforcement

Each invocation creates a detached workflow in the caller's current Solwyn frame. A workflow
inside an outer `run(...)` therefore remains a child of that run. Each distinct agent object gets
one child run, named `agent:<name>`, for the invocation. Tool turns and hand-backs reuse that ID;
handoff targets are siblings under the workflow. Same-named agent objects remain distinct.
All agent handles finish when the workflow closes. Active model work defers finishing until its
activation settles; no activation remains open across a yielded stream event.

Exact-run stops, velocity history, per-run budgets, and leases target the **agent leaf run IDs**.
Stopping a workflow parent does not recursively stop its children. Names must be non-empty and
contain no controls, format characters, line separators, paragraph separators, or lone surrogates.
The `agent:` prefix and name together must fit 255 UTF-16 code units.

Tags are explicit, non-sensitive attribution data sent verbatim to Solwyn. Set them on the
workflow; child agents inherit them. Tagged calls use per-call admission and are lease-ineligible.
Untagged, eligible text calls use the core's token leases, including reuse across an agent's tool
turns and hand-backs. Do not put prompts, responses, secrets, or sensitive identifiers in tags.

## Admitted and tested paths

- `SolwynAgents.run` and `runStreamed` over OpenAI **Chat Completions HTTP**.
- **Responses HTTP** with `api: "responses"` on `SolwynAgents`.
- Function-tool turns whose tools make no model calls; handoffs and hand-backs; concurrent
  independent invocations; nesting the workflow under a user `run(...)`.
- Runner-managed retries, budget denial, exact-run stop, and stream cancellation/cleanup.

Pass `agents.modelProvider` to the Runner, attach it, and invoke through `agents.run` or
`agents.runStreamed`. Calling `runner.run` directly with this provider fails closed at model
dispatch. Attachment is idempotent and revalidates the provider and runner-level model selection.

## Refused and unsupported paths

The integration throws a typed `SolwynError` before model dispatch for missing workflow or agent
identity, overlapping agent starts, concurrent model attempts within one invocation, and model
calls while tools execute. Agent-as-tool calls on the inherited provider and explicitly nested
integration workflows latch the violation on the outer workflow. It surfaces from `run`, from
terminal async iteration, and from `completed`, even when the framework swallows tool errors or
uses `stop_on_first_tool`.

Raw clients fail construction with `ConfigurationError(field: "client")`. Foreign runner
providers, `runner.config.model` or `Agent.model` set to a `Model` instance, invalid agent names,
and `RunState` resume are refused. Keep model selection as strings or leave it unset. HTTP model
admission uses controlled provider configuration and structural prototype checks; websocket
models and unexpected delegate shapes are refused without relying on class names.

The following are not admitted: Responses websocket transport, Realtime, hosted multi-agent
execution, sandbox agents, and HITL resume. Custom providers/models are unsupported: pass the
framework's `OpenAIProvider` class. Model calls inside tools are unsupported. Direct calls from
tool code to the wrapped client still receive core enforcement and workflow attribution, without
per-agent attribution. Guardrail runs on other runners sharing this provider are unsupported:
their sequential calls can resemble the current agent and cannot reliably be distinguished;
overlapping calls fail closed. Prefer separate, explicitly configured workflows.

## Tool errors and tracing

Agents normally turns tool exceptions into a fixed tool-result message. Set
`errorFunction: solwynToolErrorFunction` on every function tool to preserve Solwyn denial and stop
errors, including errors wrapped in a bounded `cause` chain. Other exceptions receive Agents'
unchanged default message. `errorFunction: null` is another option when every exception should
propagate. The integration's nested-run latch works independently of a tool's error function.

**Agents tracing is outside Solwyn's privacy boundary.** Framework tracing can export prompts,
responses, and tool content to OpenAI unless disabled. Keep `setTracingDisabled(true)`,
`tracingDisabled: true`, and `traceIncludeSensitiveData: false` as shown. A custom tool error
function also changes the framework's span redaction behavior, which is another reason to keep
tracing disabled when content must stay local. Solwyn's integration never exports this content.

## Responses caveats

Responses generation is metered by Solwyn core and is primary-only; cross-provider failover is
unavailable on this surface. Hosted tools such as web search, file search, code interpreter, image
generation, and computer use incur non-token charges that Solwyn does not meter. Do not treat
this integration as a budget for those charges.

Server-side context via previous response IDs, conversation IDs, and reusable prompts lowers
length-based preflight estimates. Provider-reported token usage remains settlement truth.
`background: true` and transport `extra_query` overrides are refused by core before provider I/O.
Compaction (`responses.compact`) and conversation-session administration are unmetered surfaces;
they are outside the admitted generation recipe. The wrapped client's plain streaming promise
also means Agents may lack a streamed transport request ID; usage settlement still works.

## Runtime and compatibility posture

Attribution requires importing `@solwyn/sdk/node` before constructing `SolwynAgents`. The entry
itself has no framework or Node runtime imports. In an edge runtime, use a wrapped client directly
in `new OpenAIProvider({ openAIClient: client as unknown as OpenAI, useResponses: false })` for
core enforcement without framework attribution. `SolwynAgents` construction explains the missing
Node seam with a `ConfigurationError`.

Agents is a fast-moving 0.x dependency. The tested version is **0.20.0**; runtime shape checks
refuse unexpected models and hierarchy. Validate the admitted paths again when upgrading.
For strict declaration checking with this Agents version, use `@types/node` 22.15.30 or 24:
`@types/node` 26 exposes upstream TS2416 errors in Agents' lifecycle and Realtime declarations.
Include DOM types when checking the umbrella package, which also exports Realtime declarations.
This limitation does not require changing an application's source-level strictness settings.

TypeScript ships the attribution module at `@solwyn/sdk/openai-agents`. The Python SDK's OpenAI
Agents integration remains recipe-only; the two integrations have different admitted paths.
