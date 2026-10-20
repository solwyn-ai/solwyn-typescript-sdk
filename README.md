# Solwyn TypeScript SDK

Track LLM usage, enforce budgets, and add provider failover by wrapping the client you already use.

Solwyn keeps your provider's request syntax and TypeScript request types. Your LLM calls go
directly to your provider. Solwyn receives usage and operational metadata, plus tags you
explicitly supply. Prompt and response content is not sent to Solwyn or logged by the SDK.

- **See usage first.** Start with budget warnings, then enable blocking when you are ready.
- **Keep your integration.** Use OpenAI, Anthropic, Google Gemini, Amazon Bedrock, OpenAI-compatible clients, or Vercel AI SDK middleware.
- **Add controls as you need them.** Attribute usage to runs and customers, set up fallback providers, and stop runaway agent runs.

[Quick start](#quick-start) · [Budget enforcement](#budget-enforcement) ·
[Providers](#providers) · [Vercel AI SDK](#vercel-ai-sdk) · [Framework integrations](#framework-integrations) ·
[Configuration](#configuration) · [Data transparency](#data-transparency)

> **Public preview (`0.1.1`).** Install from npm's default `latest` tag. APIs may change before
> 1.0; breaking changes are announced in the [changelog](CHANGELOG.md) and release notes before
> users upgrade.

## Installation

```sh
npm install @solwyn/sdk
# or: pnpm add @solwyn/sdk
```

The manifest retains **Node.js 20 or later** only for end-of-life (EOL) legacy installed artifact
support in the provider-free core, or a compatible [server-side edge runtime](#edge-runtimes).
Node.js 22 and 24 are the full development and release lanes. The current development toolchain,
provider integrations, and Vercel AI SDK 7 middleware require their own supported Node versions;
in particular, AI SDK 7 and the LangChain/OpenAI recipe require Node.js 22 or newer. Declarations
are consumer-tested with TypeScript 5.8.3 and 6.0.3 under `strict: true`, `skipLibCheck: false`,
and a lib set that includes `ESNext.Disposable` (for `Symbol.asyncDispose`) alongside the runtime
libraries your application uses. Supports ESM and CommonJS. Keep your existing provider package;
Solwyn bundles no provider clients.

## Quick start

You need a **Solwyn project API key** and credentials for your LLM provider. This example uses
OpenAI; [other provider examples](#providers) and [Vercel AI SDK middleware](#vercel-ai-sdk) are below.
To try budget enforcement without keys or network access, use the [offline example](#testing-budget-enforcement).

If you do not already have the OpenAI client installed:

```sh
npm install openai
```

### 1. Set your keys

Use the project API key from your Solwyn project. If you do not yet have project access, start at
[Solwyn](https://solwyn.ai). The Solwyn key and the provider key are separate credentials:

```sh
export SOLWYN_API_KEY="<your Solwyn project API key>"
export OPENAI_API_KEY="<your OpenAI API key>"
```

Keep both in your server environment or secret manager. The Solwyn key must have the format
`sk_proj_` followed by 64 hexadecimal characters; placeholder values will fail validation.

### 2. Wrap your client and make a call

Save this as `quickstart.mts`. It makes one real OpenAI request using your provider account.
Use a model available to your account if you need to change `gpt-4o`.

```ts
import { Solwyn } from "@solwyn/sdk";
import OpenAI from "openai";

const client = new Solwyn(new OpenAI(), {
  apiKey: process.env.SOLWYN_API_KEY,
});

try {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Say hello in one sentence." }],
    max_completion_tokens: 64,
  });
  console.log(response.choices[0]?.message.content);
  console.log("Provider token usage:", response.usage);
} finally {
  await client.close();
}
```

Run it with a TypeScript runner:

```sh
npm install --save-dev tsx
npx tsx quickstart.mts
```

In an existing application, wrap the provider client where you construct it and use the wrapped
client for subsequent calls. Reuse it for the application's lifetime, then await `close()` during
shutdown; scripts should use `try` / `finally` as above. See [Lifecycle](#lifecycle) for
`await using` and [OpenAI](#openai) for streaming and response-helper compatibility.

### 3. Confirm the integration

You should see a short response and provider token usage in your terminal. In your Solwyn
project, look for the call's provider, model, token counts, and latency after the script closes.
Reporting is batched; `close()` attempts to flush queued events before exit. A successful provider
response alone does not prove reporting succeeded, because the default allows calls during a
Solwyn API outage.

| If you see… | Check… |
|-------------|---------|
| `ConfigurationError` for `api_key` | Supply the full Solwyn project key, not your provider key or a placeholder. |
| A provider authentication or model error | Check the provider credentials and use a model your account can access. |
| A response but no usage in Solwyn | Await `close()`, check SDK warnings, and verify the Solwyn key and network access to the configured `apiUrl`. |
| An unmetered-surface warning | Check [provider coverage](#strict-coverage-controls); wrapping a client does not make every method metered. |

Live budget enforcement mode is configured in Solwyn Cloud, and `failOpen` defaults to `true`.
To block over-budget calls, follow [Budget enforcement](#budget-enforcement).

## Budget enforcement

Configure both limits and the live enforcement mode in Solwyn Cloud. The `mode` returned by each
live budget check is authoritative:

| Cloud response mode | Over-budget behavior |
|---------------------|----------------------|
| `alert_only` | Log a warning and allow the provider call |
| `hard_deny` | Throw `BudgetExceededError` before provider dispatch |

Alert-only budget-limit logs emit at most once every 30 seconds per enforcer. Each affected
budget result retains its warning and reservation ID.

The constructor's `budgetMode` option is not sent in `BudgetCheckRequest` and does not enable live
Cloud blocking. It supplies the mode attached to SDK-local outage decisions. `failOpen` controls
whether those local decisions allow or deny when the budget service cannot be reached.

```ts
import { BudgetExceededError } from "@solwyn/sdk";

try {
  await client.chat.completions.create({ model: "gpt-4o", messages: [/* ... */] });
} catch (err) {
  if (err instanceof BudgetExceededError) {
    // Return your application's budget-reached response, or pause this job.
    console.error(`Budget limit: ${err.budgetLimit}, usage: ${err.currentUsage}`);
  } else {
    throw err;
  }
}
```

You can verify denial handling with the [offline testing example](#testing-budget-enforcement)
before connecting it to live traffic.

**Fixed-rate local estimate.** The SDK uses **$0.00003 per estimated input token** in exactly two
places: for outage decisions and the in-process outage bucket described below, and for the
`estimatedCost` diagnostic on `BudgetExceededError`, including errors produced by a live Cloud
denial. This value is never provider/model pricing; Solwyn Cloud remains authoritative for that.

- `failOpen: true` (default) allows the call after retained-denial checks and adds the estimate to
  an in-process bucket for the current UTC day.
- `failOpen: false` denies if the SDK has never received a successful budget snapshot. Once a
  limit is known, it can allow while locally accrued estimated spend plus the new estimate stays
  within that last-known limit; otherwise it denies.

Applicable retained hard-deny authority is checked first, regardless of `failOpen`. Project-period
hard denials apply globally. `agent_run` denials and run stops apply only to the exact run. A
tag-period denial is enforced for the checked selector but is not retained as future outage
authority because tags can vary from call to call.

A response that carries a run-control directive for another run is treated as contract drift. Its
ordinary allow or budget-deny verdict is enforced for that call without retaining the tainted
composite as future authority. A foreign `run_stopped` response instead enters the configured
outage path.

Eligible calls can reuse cached authority or a run lease. Settlement is automatic and private.
Close the wrapped client to flush queued confirmations and events. See
[budget checks, settlement, and run leases](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/budgets-and-leases.md#budget-checks-settlement-and-run-leases)
for preflight deadlines, reporter delivery, and lease eligibility and renewal.

## Choose your next step

| I want to… | Start here |
|------------|------------|
| Use another provider | [Provider examples](#providers) or [Vercel AI SDK middleware](#vercel-ai-sdk) |
| Use LangChain or LangGraph | [Framework integrations](#framework-integrations) |
| Block over-budget requests | [Budget enforcement](#budget-enforcement) |
| Group usage by workflow or customer | [Agent runs and attribution tags](#tagging-calls-with-agent-runs) |
| Recover from provider failures | [Failover](#failover) |
| Stop runaway agent work | [Run control and velocity limits](#run-control-and-velocity-limits) |
| Test denial without credentials or network access | [Testing budget enforcement](#testing-budget-enforcement) |
| Require every spend surface to be reviewed | [Strict coverage controls](#strict-coverage-controls) |

The examples below assume the relevant provider package is installed and credentials are set.
Create one wrapper per provider client and close it when its work is finished.

## Providers

| Your integration | Package to install | Metered text calls |
|------------------|--------------------|--------------------|
| [OpenAI / Azure OpenAI](#openai) | `openai` | Chat Completions and native Responses |
| [Anthropic](#anthropic) | `@anthropic-ai/sdk` | `messages.create` |
| [Google Gemini](#google-gemini) | `@google/genai` | `models.generateContent` / `generateContentStream` |
| [Amazon Bedrock](#amazon-bedrock) | `@aws-sdk/client-bedrock-runtime` | Converse / ConverseStream |
| [OpenAI-compatible endpoints](#openai-compatible-providers) | `openai` (or `together-ai` for native Together) | Chat Completions |
| [Vercel AI SDK](#vercel-ai-sdk) | `ai` plus your AI SDK provider package | Language-model middleware |

For embeddings, images, audio, and video, see [Media surfaces](#media-surfaces).

See [provider compatibility](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/providers.md#compatibility)
for optional peer ranges, reviewed version cells, and provider runtime requirements.

### OpenAI

Chat Completions and the native OpenAI Responses API are instrumented. Azure OpenAI Responses
clients are supported as well:

```ts
import { Solwyn } from "@solwyn/sdk";
import OpenAI from "openai";

const client = new Solwyn(new OpenAI(), { apiKey: process.env.SOLWYN_API_KEY });

// Chat Completions
await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});

// Responses API
await client.responses.create({
  model: "gpt-4o",
  input: "Hello!",
});
```

Responses calls on native OpenAI and Azure OpenAI clients are primary-only. See the
[Responses API reference](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/providers.md#openai-responses-api)
for parsing types, deferred stream activation, supported request options, and refused shapes.

**Streaming.** Pass `stream: true` exactly as you normally would. Solwyn wraps the stream transparently and settles usage from the terminal usage chunk when iteration completes:

```ts
const stream = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

> Note: an intercepted `create(...)` returns a plain `Promise`, not OpenAI's `APIPromise`. The response-envelope helpers `.withResponse()` / `.asResponse()` are unavailable on an intercepted call — a deliberate divergence surfaced as a **compile** error rather than a runtime crash. Every non-intercepted path keeps OpenAI's exact types.

The Chat Completions helpers `chat.completions.stream`, `chat.completions.parse`, and
`chat.completions.runTools` are unmetered. With the default `onUnmetered: "warn"`, each
surface passes through after one warning, with no budget check or cost event. Use
`chat.completions.create` for metered calls, including streaming with `stream: true`.

### Anthropic

```ts
import { Solwyn } from "@solwyn/sdk";
import Anthropic from "@anthropic-ai/sdk";

const client = new Solwyn(new Anthropic(), { apiKey: process.env.SOLWYN_API_KEY });

await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

`messages.stream` and `messages.parse` are unmetered helpers. With the default
`onUnmetered: "warn"`, each passes through after one warning, with no budget check or cost
event. Use `messages.create`, with `stream: true` for streaming, for metered calls.

See [Anthropic streaming usage](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/providers.md#anthropic-streaming-usage)
for cumulative counters, cache accounting, thinking tokens, and service tiers.

### Google Gemini

```ts
import { Solwyn } from "@solwyn/sdk";
import { GoogleGenAI } from "@google/genai";

const client = new Solwyn(new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY }), { apiKey: process.env.SOLWYN_API_KEY });

// Non-streaming
await client.models.generateContent({ model: "gemini-2.0-flash", contents: "Hello!" });

// Streaming — the Gemini SDK expresses streaming intent by method choice
const stream = await client.models.generateContentStream({
  model: "gemini-2.0-flash",
  contents: "Hello!",
});
for await (const chunk of stream) {
  process.stdout.write(chunk.text ?? "");
}
```

If a Google stream omits the candidate output count, its usage remains estimated until a
candidate finish reason is observed. Cancelling an unfinished stream retains the reservation
floor. Buffered responses and finished streams can report omitted candidate output as zero.

### Amazon Bedrock

Wrap an AWS SDK v3 `BedrockRuntimeClient`. Solwyn intercepts `client.send(command)` for the [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) (`ConverseCommand` / `ConverseStreamCommand`), which works uniformly across every chat model Bedrock hosts — Anthropic Claude, Meta Llama, Mistral, Amazon Nova, Cohere, AI21, DeepSeek, and more. Commands are detected by shape and constructor name — **no `@aws-sdk/*` types are imported**. Auth stays entirely on your AWS client (IAM credentials, profiles, roles, SigV4) — Solwyn never sees it.

```ts
import { Solwyn } from "@solwyn/sdk";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const bedrock = new BedrockRuntimeClient({ region: "us-east-1" });
const client = new Solwyn(bedrock, { apiKey: process.env.SOLWYN_API_KEY });

const res = await client.send(
  new ConverseCommand({
    modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [{ role: "user", content: [{ text: "Hello!" }] }],
    inferenceConfig: { maxTokens: 1024 },
  }),
);
```

Streaming preserves the native contract; usage settles from the stream's terminal `metadata` event:

```ts
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

const res = await client.send(
  new ConverseStreamCommand({
    modelId: "amazon.nova-pro-v1:0",
    messages: [{ role: "user", content: [{ text: "Hello!" }] }],
  }),
);
for await (const event of res.stream ?? []) {
  // ...
}
```

Every `InvokeModel*` command, including `InvokeModelCommand`,
`InvokeModelWithResponseStreamCommand`, and `InvokeModelWithBidirectionalStreamCommand`,
raises `ConfigurationError` instead of bypassing budget tracking. See
[Bedrock details](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/providers.md#amazon-bedrock-details)
for model and region attribution, other commands, and callback limitations.

### OpenAI-compatible providers

Point an `OpenAI` client at any OpenAI-compatible endpoint via `baseURL` and wrap it as usual. Solwyn detects the provider from the URL, so budgets, per-provider attribution, failover, and the cost dashboard all see the **real** provider (e.g. `groq`), not `openai`:

```ts
import { Solwyn } from "@solwyn/sdk";
import OpenAI from "openai";

const client = new Solwyn(
  new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY }),
  { apiKey: process.env.SOLWYN_API_KEY },
);

await client.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Hello!" }],
});
```

See [OpenAI-compatible detection](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/providers.md#openai-compatible-detection)
for the host table and explicit provider pins. A pin bypasses detection and synchronously
rejects an incompatible client family with `ConfigurationError(field: "client")`.

**Token accounting.** Provider-reported usage is settlement truth. For pre-flight checks — and when a provider reports **no** usable usage at all (or an unparseable/zeroed block alongside real content) — Solwyn uses a heuristic, length-based estimate that is **explicitly marked** (`token_details.is_estimated = true` on the wire). Degraded accounting is loud and flagged, never silently zero; the SDK performs no exact tokenization.

**Pricing.** Solwyn Cloud owns real provider/model pricing. The SDK reports the served
`(provider, model)` verbatim — for OpenRouter that is the full model slug (for example,
`anthropic/claude-sonnet-4.5`). Its fixed `$0.00003 × estimated input tokens` calculation has two
local uses only: outage decisions/bucketing and the `estimatedCost` diagnostic on denial errors,
including live denials. It is not used to price a provider or model.

## Vercel AI SDK

For the OpenAI example below, install `ai` and `@ai-sdk/openai` alongside Solwyn:

```sh
npm install ai @ai-sdk/openai
```

For code built on the [Vercel AI SDK](https://sdk.vercel.ai) (`generateText` / `streamText`), Solwyn ships a language-model middleware from the `@solwyn/sdk/ai-sdk` entry. It runs a pre-flight budget check before the model call and settles usage after, without logging content or sending content to Solwyn.

```ts
import { generateText, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { createSolwynMiddleware } from "@solwyn/sdk/ai-sdk";

const solwyn = createSolwynMiddleware({ apiKey: process.env.SOLWYN_API_KEY! });

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: solwyn.middleware,
});

try {
  const { text } = await generateText({ model, prompt: "Hello!" });
  console.log(text);
} finally {
  await solwyn.close();
}
```

The middleware handle owns the budget enforcer + reporter; call `solwyn.close()` (or use `await using`) to flush queued telemetry. Attribution is derived from the wrapped model's `provider`/`modelId`; there is no failover here (the AI SDK owns the single model), so every event is a primary hop.

When garbage collection finalizes an abandoned middleware stream, Solwyn settles its observed
usage once and releases run and lease ownership, matching the drop-in client. Missing or
malformed usage retains the reservation floor. Finalization timing is runtime-dependent;
consume or cancel streams explicitly for deterministic settlement. Closing the middleware
settles open streams before reporting shuts down; later finalization cannot settle them again.

Run stops are cooperative: the middleware rechecks the captured run after preflight and
aborts an active stream at its next chunk boundary with `RunStoppedError`. Clearing a stop
allows future work; an already stopped stream retains its stop. Local velocity detection
is not supported by the AI SDK middleware. Cache writes are reported in the default
five-minute bucket, and missing usage totals fall back to length estimates for that side
of the call while preserving reported totals. The middleware limits cache reads to input tokens
and cache writes to the remaining input. Clamped or malformed counters mark usage estimated
and retain the lease reservation floor.

The call's `abortSignal` also cancels budget preflight. Run stops and caller cancellation
settle stream usage observed so far, including the part pulled at the cancellation boundary;
estimated usage retains the reservation floor.

> **Gateway attribution.** When a model id is resolved through the Vercel AI Gateway (a bare string model like `generateText({ model: "anthropic/claude-sonnet-4.5" })`), the AI SDK stamps `provider: "gateway"`. Solwyn derives the true vendor from the `vendor/model` prefix of the model id, so per-vendor budgets and metadata are attributed correctly instead of collapsing onto `openai_compatible`.

## Framework integrations

Use the [LangChain.js / LangGraph.js recipe](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/integrations/langchain.md)
with `@solwyn/sdk/langchain` on Node.js 22+. `SolwynRunScopeHandler` adds content-free chain and
stable graph-node attribution; the Solwyn-wrapped OpenAI client supplies enforcement and
settlement. The exact recipe admits Chat Completions chain `invoke`/`stream`, compiled graph
values/updates/messages streaming, parallel nodes, loops, and function-tool binding. Responses
and non-streaming JSON-schema parsing fail closed; streaming structured output is outside the
tested recipe. Other paths are listed on the recipe page.

| Framework | Integration | Runtime |
|---|---|---|
| LangChain.js / LangGraph.js | `@solwyn/sdk/langchain` plus the documented OpenAI recipe | Node.js 22+ for attribution |
| CrewAI | Not available: no official TypeScript SDK | — |

CrewAI is Python-only; its official JavaScript route calls a REST API for hosted crews, so there
is no in-process provider client to wrap. See the [framework support matrix](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/integrations/README.md)
for tested versions, dependency posture, hierarchy, and exclusions. Tags remain explicit,
non-sensitive attribution; tagged calls use per-call checks instead of token leases.
LangSmith tracing can export content to LangSmith, outside Solwyn's privacy boundary.

## Media surfaces

Tracked non-text calls use the same lifecycle as text calls: a pre-flight budget check,
the provider call, then a confirmation when the check returned a reservation and either
token usage or a media quantity is observable. Each request and event is tagged with its
media modality (`embedding`, `image`, `audio`, or `video`) on budget checks, confirmations,
successful events, and budget-denied events. A failed provider dispatch uses the shared
error-event shape, whose modality remains `text`. Media calls always use the primary client:
there is no cross-provider failover, translation, retry walk, or streaming for these surfaces.

| Modality | Provider method |
|----------|-----------------|
| Embeddings | OpenAI and compatible clients: `embeddings.create`; Google: `models.embedContent` |
| Images | OpenAI and compatible clients: `images.generate` / `images.edit`; Google: `models.generateImages` |
| Audio input | OpenAI and compatible clients: `audio.transcriptions.create` (including Groq Whisper) |
| Audio output | OpenAI and compatible clients: `audio.speech.create` |
| Video | OpenAI Sora: `videos.create`; Google Veo: `models.generateVideos` |

Solwyn uses provider-reported usage when available. Otherwise, it derives only the minimum
billing quantities available from the request: lengths, pre-tokenized array sizes, image or
generation counts, durations, and bounded resolution/quality selectors. It never reads the
media itself. If neither token usage nor a media quantity is observable, the call is still
reported as a successful but unpriced event and no confirmation is sent — usage is never
silently replaced with zero.

Three current posture details are deliberate:

- Whisper transcription responses without usage are reported unpriced. A one-time hint
  recommends `response_format: "json"` or `"verbose_json"`, where usage can be returned.
- The `gpt-4o-mini-tts` model family exposes no usable billing quantity, so
  `audio.speech.create` passes through untracked after a one-time warning: no budget check
  or cost event is emitted.
- `audio.translations` is not intercepted yet. It passes through untracked with a one-time
  warning.

## Strict coverage controls

Solwyn classifies the public pre-call capability graph of each wrapped provider client.
Tracked leaves are intercepted as usual, while known untracked leaves and newly observed
leaves follow `onUnmetered`: `"warn"` logs once and permits the call, `"raise"` refuses it
before provider I/O, and `"allow"` permits it without warning. In strict mode, use
`acknowledgeUntracked` only for narrow, deliberately reviewed exceptions; an acknowledgment
does not make a whole namespace safe.

See the [coverage reference](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/coverage.md#strict-coverage-controls)
for unmetered surfaces, advisory delivery, and the independently reviewed strict-mode CI fingerprint.

Strict mode is a cooperative pre-call guard, not a sandbox. Retaining the raw provider client,
reaching private wrapper state, acknowledging a scoped raw escape, or invoking behavior on a
returned response, page, stream, job, or operation object can bypass this guard. Fixed
non-configurable descriptors retain their native values and accessors to preserve JavaScript
Proxy invariants, and can also expose raw capabilities; keep those
capabilities out of code that relies on strict enforcement or review their use explicitly.

## Failover

Provide an ordered `fallback` chain of alternate clients. Each entry is a positional array:

```ts
// [client, model]
// [client, model, defaultParams]
// [client, model, defaultParams, providerOverride]
const client = new Solwyn(new OpenAI(), {
  apiKey: process.env.SOLWYN_API_KEY,
  fallback: [
    [new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY }), "llama-3.3-70b-versatile"],
    [new Anthropic(), "claude-sonnet-4-20250514"],
  ],
});
```

On a failover-eligible error the router walks `[primary, ...fallbacks]` in health order.

Circuit breakers, latency signals, and failover labeling key off the provider **name** — so give distinct endpoints distinct identities (via `provider` or the 4th fallback element) when you want them tracked separately.

**Selection policy.** Attempt order is chosen by an injectable `selectionPolicy` (the drop-in seam — swapping it changes ordering with zero changes to dispatch, translation, or budgets):

- `HealthBasedPolicy` — health-tier ordering (default).
- `LatencyPolicy` — prefers lower observed p50 latency.
- `CostPolicy` — prefers cheaper providers using server-supplied price hints.

**Cross-dialect translation.** A failover hop between two clients of the **same** dialect (e.g. Groq → OpenRouter) is a native passthrough. A hop **across** dialects (e.g. OpenAI → Anthropic) runs a minimal canonical translation subset and **fails loud** rather than silently mangling a request: an untranslatable request raises `UntranslatableRequestError`, and a missing target model mapping raises `UntranslatableModelError`. These errors abort the whole chain — they are never swallowed into a retry.

> **Bedrock note.** Bedrock supports failover between Bedrock clients. Failover from another client family into Bedrock raises `UntranslatableRequestError`; use another Bedrock client as the fallback for a Bedrock primary.

See the [failover reference](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/failover.md#failover)
for timeout phases, cancellation, idempotency, selection-policy examples, request-scoped
price hints, and retry controls.

## Tagging calls with agent runs

Wrap a unit of work with `run(name, fn)` to attribute every LLM call inside it to a single agent run. The dashboard groups cost and latency by run. This lives in the **Node-only** `@solwyn/sdk/node` entry (it is built on `AsyncLocalStorage`):

```ts
import { Solwyn } from "@solwyn/sdk";
import { run } from "@solwyn/sdk/node";
import OpenAI from "openai";

const client = new Solwyn(new OpenAI(), { apiKey: process.env.SOLWYN_API_KEY });

await run("nightly-batch", async () => {
  await client.chat.completions.create({ model: "gpt-4o", messages: [/* ... */] });
  await client.chat.completions.create({ model: "gpt-4o", messages: [/* ... */] });
});
```

`run(name, fn)` is callback-based and returns whatever `fn` returns. Ordinary async work (`await`, `setTimeout`, promises) propagates the active run automatically, including streaming calls drained later within the same async flow. Concurrent async tasks each in their own `run(...)` are fully isolated. Calls made outside any `run(...)` scope are still tracked; the API groups them automatically.

For a stable run identity that crosses separately scheduled call stacks, use
[detached run handles](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/run-control.md#detached-run-handles)
with `createRun()`, `activate(fn)`, and `finish()`.

Add attribution tags at the client, run, or individual-call layer. Higher-priority layers win on duplicate keys: per-call `solwyn_tags`, then run tags, then client defaults. Nested runs inherit their parent's tags by default; pass `inheritTags: false` to start a fresh tag set.

```ts
const client = new Solwyn(new OpenAI(), {
  apiKey: process.env.SOLWYN_API_KEY,
  tags: { environment: "production" },
});

await run("nightly-batch", { tags: { job: "summarize" } }, async () => {
  const request = {
    model: "gpt-4o",
    messages: [{ role: "user" as const, content: "Hello!" }],
    solwyn_tags: { customer: "acme" },
  };
  await client.chat.completions.create(request);
});
```

The merged tag set is limited to 10 keys; keys may contain up to 64 characters and values up to 256. `solwyn_tags` is removed before intercepted requests reach the provider. On non-intercepted passthrough methods, it is forwarded unchanged with the rest of the caller's arguments.

Tags are explicit customer-provided metadata, not prompt or response fields. Their keys and values
are transmitted verbatim on applicable control-plane messages, so do not put secrets, prompts,
responses, or other sensitive content in tags. Tagged calls use the per-call budget path rather
than run leases so tag-scoped policy remains authoritative.

## Run control and velocity limits

The control plane can terminate an exact agent run through a versioned directive returned by a
budget check, lease grant, or lease renewal. A stop blocks later dispatches for that run and aborts
an already-returned stream at the next raw provider-chunk boundary. The SDK raises
`RunStoppedError` with `agentRunId`, a bounded structural `reason`, and `source` (`"server"` or
`"local_velocity"`). It inherits directly from `SolwynError` and is deliberately **not** a
`BudgetExceededError`, so budget-retry handlers do not swallow an operator stop.

The same cooperative mechanism can stop runaway work locally. It observes only run ID, model,
timestamps, and estimated input-token counts — never prompts or responses. In `"warn"` mode it
adds structural `velocity_flags` and rate-limited warnings; in `"deny"` mode only
`repeat_size` and `monotonic_growth` can terminate a run. `rate_acceleration` is advisory.

See [run control and velocity limits](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/run-control.md#run-control-and-velocity-limits)
for thresholds, environment variables, history bounds, and intentional recovery with
`clearRunTermination(runId)`. Clearing a stop changes future work; an already stopped stream
keeps aborting.

## Testing budget enforcement

`FakeControlPlane` is an in-process, zero-network double for the Solwyn Cloud control plane. A
wrapped client sends no control-plane traffic; passing a live `fetch` or URL to the contract
helpers is always the caller's choice. Provider traffic is a separate boundary: use a real
provider client only when the test is meant to exercise it.

The fake never computes prices and never reads or sees prompt or response content. It serves
caller-provisioned budget state and records only the content-free control-plane wire models.
Run-scoped magic models require an active Node run context established by `run()` or
`RunHandle.activate(...)` from `@solwyn/sdk/node`; the testing entry itself remains edge-safe.

Import the double from the dedicated testing entry and wrap a provider-shaped client with
`plane.wrap(...)`. This denial-only example proves that a hard denial does not dispatch to the
provider:

```ts
import { BudgetExceededError } from "@solwyn/sdk";
import { denialOnlyOpenAIClient, FakeControlPlane } from "@solwyn/sdk/testing";

const plane = new FakeControlPlane();
plane.denyNext();
const client = plane.wrap(denialOnlyOpenAIClient(), {
  leaseEnabled: false,
  model: "gpt-4o",
});

try {
  await client.chat.completions.create();
  throw new Error("expected the scripted denial");
} catch (error) {
  if (!(error instanceof BudgetExceededError)) throw error;
} finally {
  await client.close();
}
```

See the [testing reference](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/testing.md#testing-budget-enforcement)
for outages, operator kills, the seven magic models, contract probes, and
[opt-in Vitest fixtures](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/testing.md#vitest-fixtures-explicit-opt-in).

## Edge runtimes

The core (`@solwyn/sdk`) is designed to be **edge-safe**: it uses only web-standard APIs (`fetch`,
`AbortController`, `crypto.randomUUID`, web streams) and imports no `node:*` modules. The release
checks validate browser-target and edge-compatible bundles; that does not by itself certify a
deployment on every named edge platform.

Callback `run(...)` and detached `createRun()` / `RunHandle.activate(...)` are Node-only
conveniences. They depend on `AsyncLocalStorage` and live behind the separate `@solwyn/sdk/node`
entry. On an edge runtime, run context is unavailable (metadata events omit `agent_run_id` /
`agent_run_name`); everything else works.

## Lifecycle

The client owns background metadata, advisory, and lease state. Shut it down so queued telemetry
is flushed, retained denial receipts get a final replay attempt when shutdown-deadline time
remains, live lease authority is surrendered best-effort, and the wrapped provider client's own
`close()` is forwarded last:

```ts
const client = new Solwyn(new OpenAI(), { apiKey: process.env.SOLWYN_API_KEY });
try {
  // ...
} finally {
  await client.close();
}
```

Once `close()` begins, new intercepted calls reject with `SolwynError("client is closed")`
before a budget check or provider request. Deferred `responses.stream()` helpers issued earlier
also reject if first activated after closing begins. Repeated `close()` and async disposal share
the same shutdown promise.

Buffered calls and stream setup already in flight drain within `reporterShutdownDeadline`;
settlement delivery and the advisory reporter use the time remaining in that same deadline.
A call that outlasts it can finish after reporting closes, and the SDK logs a shutdown warning
with the number still active. The settlement reporter closes first, followed by the advisory
reporter, budget/lease holder, and wrapped provider. Lease cleanup has a separate one-second
budget, so Solwyn's asynchronous shutdown work is bounded by `reporterShutdownDeadline + 1`
seconds, plus the wrapped provider's own `close()` duration.

Open streams settle once from usage observed so far, without waiting for the consumer to pull
another chunk. A pull that receives another provider chunk rejects with
`SolwynError("client is closed")`. Finish or cancel streams before closing the client when you
need their terminal usage included; provider stream cleanup still belongs to the consumer.
Missing or malformed usage retains the reservation floor during settlement; correcting
inconsistent cache totals settles the adjusted observed usage.

Both the drop-in client and AI SDK middleware settle abandoned streams from observed usage
when garbage collection finalizes them, releasing run and lease ownership before shutdown.
Missing or malformed usage keeps the reservation floor. These settlements supply no routing
latency samples. Finalization timing is runtime-dependent; finish or cancel streams explicitly
for deterministic settlement.

Or let `await using` do it:

```ts
await using client = new Solwyn(new OpenAI(), { apiKey: process.env.SOLWYN_API_KEY });
// close() runs at scope exit.
```

The AI SDK middleware handle also rejects new calls once closing begins, drains buffered
calls and stream setup within the shared reporting deadline, and settles open streams from
observed usage. Its `close()` and `Symbol.asyncDispose` share one shutdown promise. The handle
closes its reporter before its budget/lease holder; the AI SDK owns provider cleanup.

See [wrapper compatibility](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/providers.md#wrapper-compatibility)
for reflection, mutation forwarding, double-wrap rejection, and surface-policy behavior.

## Configuration

Pass constructor options in camelCase. Environment variables are consulted only when the
corresponding option is `undefined`; an explicit `false`, `0`, or `""` wins over the environment.
Unknown keys and a present non-function `fetch` fail synchronously with `ConfigurationError`.

See the [configuration reference](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/configuration.md#constructor-options-and-environment-variables)
for every option, environment variable, default, validation rule, and provider timeout phase.

## Error handling

All SDK errors inherit from `SolwynError`:

| Error | Thrown when |
|-------|-------------|
| `BudgetExceededError` | An ordinary budget denial blocks the call: a live Cloud hard denial, an applicable retained project/run budget denial, or a local fail-closed denial when `failOpen: false` (run-control stops use `RunStoppedError`) |
| `RunStoppedError` | The control plane or local velocity policy has stopped the active run; direct `SolwynError`, not `BudgetExceededError` |
| `ProviderUnavailableError` | Circuit breaker is open, or the failover chain is exhausted |
| `ConfigurationError` | Invalid API key format, invalid `provider` override, an unexpected option, or an untracked call surface (e.g. Bedrock `InvokeModel`) |
| `UnsupportedSurfaceError` | A known provider cannot safely dispatch a tracked surface |
| `UntrackedSpendSurfaceError` | `onUnmetered: "raise"` blocks an unknown or explicitly unmetered spend surface |
| `CoverageMismatchError` | A local provider graph differs from a reviewed `coverage(...).expect(...)` fingerprint |
| `UntranslatableRequestError` | A cross-provider failover hop cannot represent the request (structural labels only — never content) |
| `UntranslatableModelError` | No model mapping exists for a cross-provider failover hop |

Provider errors (e.g. `openai`'s `RateLimitError`) pass through unmodified.

## Reference documentation

- [Configuration and environment variables](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/configuration.md#constructor-options-and-environment-variables)
- [Provider compatibility and details](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/providers.md#provider-reference)
- [Coverage policies and CI fingerprints](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/coverage.md#strict-coverage-controls)
- [Failover, timeouts, and idempotency](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/failover.md#failover)
- [Budget checks, settlement, and run leases](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/budgets-and-leases.md#budget-checks-settlement-and-run-leases)
- [Run control, velocity limits, and detached handles](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/run-control.md#run-control-and-velocity-limits)
- [Testing double, magic models, and fixtures](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/docs/testing.md#testing-budget-enforcement)

## Data transparency

The SDK sends content-free call/outcome events to the metadata-ingest endpoint. This table lists
the metadata-event fields; it is not the complete control-plane wire inventory:

| Field | Description |
|-------|-------------|
| `model` | Model name (e.g. `gpt-4o`) |
| `provider` | Provider identifier (`openai`, `anthropic`, `google`, `bedrock`, `groq`, …) |
| `input_tokens` / `output_tokens` | Token counts |
| `token_details` | Breakdown: cached, reasoning, audio, and image input/output tokens; `is_estimated` flags estimates and corrected inconsistent cache totals |
| `media_usage` | Observable media quantities and selectors (counts, characters, seconds, resolution, quality), with estimates explicitly flagged |
| `modality` | `text`, `embedding`, `image`, `audio`, or `video` |
| `latency_ms` | Call duration in milliseconds |
| `status` | `success`, `error`, or `budget_denied` |
| `is_model_fallback` / `is_provider_fallback` | Whether a fallback entry served the call |
| `requested_provider` / `requested_model` / `attempt_index` | Requested target and the serving attempt index |
| `call_id` | Per-call identity used to correlate settlement and metadata |
| `failover_reason` / `failover_error_class` | Why the router advanced (structural class name only — never a message body) |
| `possibly_succeeded` / `service_tier` | Ambiguous-delivery marker and provider-reported tier, when available |
| `sdk_instance_id` | Per-process UUID for deduplication |
| `timestamp` | When the call completed (UTC) |
| `agent_run_id` / `agent_run_name` / `parent_agent_run_id` | From the active `run(...)` scope, if any |
| `tags` | Explicit attribution tags supplied by the customer, if any |
| `provider_region` | Cloud region of the serving endpoint (Bedrock — pricing is per model and region) |
| `deny_source` / `deny_reason` / `denied_by_period` | Structural attribution for a denied call |
| `estimated_output_bound` / `velocity_flags` | Denial reservation bound and local velocity signals |
| `receipt_aggregate_count` / `receipt_pricing_input_tokens` | Aggregate replay cardinality and optional pricing basis after recovery |

Other content-free control-plane messages include budget checks and settlement confirmations,
lease grant/renew/surrender requests, untracked-surface advisories, and provider-breaker reports.
They carry only the structural request, accounting, run, and explicit attribution context needed
for those operations — never prompt or response content.

Your LLM calls go directly to your provider. Solwyn receives usage and operational metadata, plus
tags you explicitly supply. Prompt and response content is not sent to Solwyn or logged by the
SDK.

For the drop-in client, content is inspected inside your application process only when needed for
length-based token estimation or cross-dialect request translation. The separately selected AI
SDK middleware receives content inside that middleware pipeline, but applies the same no-log and
no-Solwyn-content rule. The privacy firewall is enforced by a path-based structural test
(`tests/unit/privacy-firewall.test.ts`). Requests still go to your chosen provider, including a
configured fallback when failover occurs.

**Attribution tags are explicit metadata, not prompt/response fields.** The SDK never infers tags
from prompts or responses, but it does transmit caller-supplied tag keys and values as provided.
Treat tags as telemetry labels and never place sensitive content in them.

**Denial receipts survive ordinary reporter loss.** When a `budget_denied` event is evicted,
retry-exhausted, or rejected as a whole batch, the reporter folds its content-free accounting
fields into a bounded aggregate. After a later clean ingest cycle, it emits a fresh event with
`deny_source: "aggregate_replay"` and `receipt_aggregate_count`; close makes one final replay
attempt behind already-queued live events only when shutdown-deadline time remains. Folds retain
structural quantities and run/model identifiers needed for accounting, never prompt/response
fields or tags. When the deadline is already exhausted (including a configured deadline of `0`),
or replay otherwise cannot complete, terminal weighted drop counters preserve the represented
cardinality rather than silently counting the aggregate as one event.

## Development

```sh
pnpm check   # biome lint + format check, tsc --noEmit
pnpm test    # unit tests (vitest, fully offline, mocked fetch)
pnpm build   # dual ESM + CJS + .d.ts
pnpm test:live # opt-in local control-plane checks with fake providers; build first
```

The [verification guide](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/scripts/verification/README.md) documents package/runtime checks and
the live harness. Live checks require a disposable control plane and explicit credentials;
they skip when the required URL or key is unset and remain separate from `pnpm test`.

## Contributing

See the public [contributor guide](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/CONTRIBUTING.md)
for the full workflow and public-content policy.

## Security

Report vulnerabilities through the
[Security Policy](https://github.com/solwyn-ai/solwyn-typescript-sdk/security/policy), not a public
issue.

## License

Apache-2.0 — see [LICENSE](LICENSE).
