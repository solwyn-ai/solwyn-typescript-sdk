# Solwyn TypeScript SDK

Track LLM usage, enforce budgets, and add provider failover by wrapping the client you already use.

Solwyn keeps your provider's request syntax and TypeScript request types. Your LLM calls go
directly to your provider. Solwyn receives usage and operational metadata, plus tags you
explicitly supply. Prompt and response content is not sent to Solwyn or logged by the SDK.

- **See usage first.** Start with budget warnings, then enable blocking when you are ready.
- **Keep your integration.** Use OpenAI, Anthropic, Google Gemini, Amazon Bedrock, OpenAI-compatible clients, or Vercel AI SDK middleware.
- **Add controls as you need them.** Attribute usage to runs and customers, set up fallback providers, and stop runaway agent runs.

[Quick start](#quick-start) · [Budget enforcement](#budget-enforcement) ·
[Providers](#providers) · [Vercel AI SDK](#vercel-ai-sdk) ·
[Configuration](#configuration) · [Data transparency](#data-transparency)

> **Public preview (`0.1.0-rc.1`).** Published prereleases use npm's `next` tag. If npm does not
> list this version, registry installation is unavailable. APIs may change before 1.0; breaking
> changes are announced in the [changelog](CHANGELOG.md) and release notes before users upgrade.

## Installation

```sh
npm install @solwyn/sdk@next
# or: pnpm add @solwyn/sdk@next
```

The manifest retains **Node.js 20 or later** only for end-of-life (EOL) legacy installed artifact
support in the provider-free core, or a compatible [server-side edge runtime](#edge-runtimes).
Node.js 22 and 24 are the full development and release lanes. The current development toolchain,
provider integrations, and Vercel AI SDK 7 middleware require their own supported Node versions;
in particular, AI SDK 7 requires Node.js 22 or newer. Declarations are consumer-tested with
TypeScript 5.8.3 and 6.0.3 under `strict: true`, `skipLibCheck: false`, and a lib set that includes
`ESNext.Disposable` (for `Symbol.asyncDispose`) alongside the runtime libraries your application
uses. Supports ESM and CommonJS. Keep your existing provider package; Solwyn bundles no provider
clients.

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

<details>
<summary>How budget checks, settlement, and run leases work</summary>

Tracked calls obtain budget authority before provider dispatch, using a length-based input-token
estimate. The ordinary check path uses `POST /api/v1/budgets/check`; when it returns a reservation,
the reporter settles it through `POST /api/v1/budgets/confirm` with observed usage. Streaming
settles once, at stream end. Eligible calls can reuse cached authority or a run lease. A hard
deny throws before provider dispatch and reports a `budget_denied` event carrying the estimate.

Settlement is automatic and private. Close the wrapped client to flush queued confirmations
and events; your application does not need a separate confirmation call.

**Run-scoped leases.** With `leaseEnabled: true` (the default), an untagged text call inside a
Node `run(...)` or `RunHandle.activate(...)` scope can reserve estimated input plus an output bound
from a local run lease. That removes a control-plane round trip from most calls while the lease is
live. Grants and renewals are generation-fenced; renewal is detached from the call path, and
`close()` surrenders remaining authority best-effort after queued telemetry is flushed. Tagged
calls, media calls, ineligible models, and calls outside a run keep the ordinary per-call check.
If a grant is refused with 409, or a renewal comes back ineligible, the run uses per-call checks
for at most 150 seconds; after an ineligible renewal the SDK releases its lease and acquires a
new one as soon as the release is confirmed. An ineligible initial grant keeps the run on
per-call checks.
Set `leaseOutputBoundDefault` (default `4096`) to change the fallback reservation when a request
does not expose a usable structural output cap.

</details>

## Choose your next step

| I want to… | Start here |
|------------|------------|
| Use another provider | [Provider examples](#providers) or [Vercel AI SDK middleware](#vercel-ai-sdk) |
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

Optional provider peers are bounded to the reviewed major-version intervals:

| Package | Optional peer range | Reviewed boundary or integration cells |
|---------|---------------------|----------------------------------------|
| `openai` | `>=4.41.0 <7` | 4.41.0 and 6.45.0 surface cells; deeper checks at 6.45.0 |
| `@anthropic-ai/sdk` | `>=0.30.0 <1` | 0.30.0 and 0.123.0 surface cells; deeper checks at 0.123.0 |
| `@aws-sdk/client-bedrock-runtime` | `>=3.422.0 <4` | 3.422.0 and 3.1124.0 surface cells |
| `@google/genai` | `>=0.3.1 <3` | 0.3.1 and 2.20.0 surface cells and deeper checks |
| `together-ai` | `>=0.16.0 <1` | 0.16.0 and 0.50.0 surface cells |
| `ai` | `>=7.0.14 <8` | Vercel AI SDK integration checks at 7.0.14 |

`@google/generative-ai` has one reviewed surface cell at 0.24.1 and is not an optional peer; do
not infer a supported peer interval from that evidence.

Boundary cells are not continuous-version coverage: they do not claim that every intervening
version received every runtime scenario. Only the named cells are release-validated; the manifest
intervals admit other compatible versions within the bounded majors without claiming the same
depth of evidence for each version.

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

<details>
<summary>Responses API coverage and limitations</summary>

For Responses, Solwyn meters `responses.create`, `responses.parse`, and `responses.stream` on
native OpenAI and Azure OpenAI clients. Calls are primary-only: they never enter the fallback or
translation walk. Buffered and streaming calls settle provider-reported Responses usage; missing
or unusable zero usage falls back to the pre-flight estimate and is marked as estimated.

The `responses.stream()` helper is deferred: the control-plane check and provider request begin on
first iteration or when `finalResponse()`, `done()`, `on()`, `once()`, or `emitted()` first needs
the stream. `once()` activates after registering its listener; `off()` remains inert and does not
activate the request. Calling `abort()` before activation performs no provider dispatch. The
wrapper retains the native helper shape (`abort`, `done`, `finalResponse`,
`on`/`off`/`once`/`emitted`, `controller`, and async iteration).

Solwyn refuses Responses shapes it cannot meter consistently before budget or provider I/O:

- queued `responses.create({ background: true })`;
- streaming `responses.parse(...)`;
- second-argument request options containing `body` or `query`, which can override the request the
  budget check saw.

Headers, signals, timeouts, and `maxRetries` request options remain supported. Caller-supplied
Responses `stream_options` are preserved but never injected; chat-only response-size defaults are
not copied into Responses calls.

</details>

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

Streaming settles usage from the terminal `message_delta` event.

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

Notes:

- Model identity is reported exactly as you pass it — foundation-model ids, cross-region inference profiles (`us.` / `eu.` / `jp.` / `global.` …), or full ARNs — together with the client's region (from `client.config.region`), because Bedrock pricing is keyed per model **and** region.
- `InvokeModelCommand` / `InvokeModelWithResponseStreamCommand` raise `ConfigurationError` instead of bypassing budget tracking (their usage is buried in a consume-once body alongside response content). Use Converse, or call the unwrapped AWS client directly for deliberately untracked calls.
- Any **other** command passes straight through to the wrapped client's native `send`. An unrecognized command that carries `input.modelId` passes through untracked with a one-time warning (never silently).
- The callback form `send(command, callback)` is not budget-trackable on an intercepted command and fails loud — await the returned Promise instead.

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

Auto-detected providers (by base-URL host):

| Provider | Detected from |
|----------|---------------|
| xAI (Grok) | `api.x.ai` |
| DeepSeek | `api.deepseek.com` |
| Mistral | `api.mistral.ai` |
| Qwen (DashScope) | `dashscope*.aliyuncs.com` |
| Z.ai | `api.z.ai` (`include_usage` is injected for streaming calls) |
| Groq | `api.groq.com` |
| Together AI (first-class) | Native `together-ai` client or `api.together.xyz` / `api.together.ai` |
| Fireworks | `api.fireworks.ai` |
| Perplexity | `api.perplexity.ai` |
| Azure OpenAI | `*.openai.azure.com` / `*.cognitiveservices.azure.com` |
| OpenRouter | `openrouter.ai` |
| Ollama | `localhost:11434` |
| vLLM | `localhost:8000` |
| LM Studio | `localhost:1234` |
| Anything else | any non-OpenAI `baseURL` → generic `openai_compatible` |

For endpoints auto-detection can't name (e.g. vLLM on a non-default port), pass the provider explicitly — on the constructor for the primary, or as the 4th element of a fallback entry:

```ts
const client = new Solwyn(
  new OpenAI({ baseURL: "http://gpu-box:8080/v1", apiKey: "-" }),
  {
    apiKey: process.env.SOLWYN_API_KEY,
    provider: "vllm",
    fallback: [
      [new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY }), "openrouter/auto"],
    ],
  },
);
```

An explicit `provider` is an attribution-and-dialect pin, not a cosmetic relabel. It bypasses URL
and constructor-based provider detection, then synchronously validates that the object belongs to
the pinned client family (OpenAI-compatible, Anthropic, Google GenAI, or Bedrock Runtime). A
mismatch fails before background work starts with `ConfigurationError(field: "client")`.

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

> **Gateway attribution.** When a model id is resolved through the Vercel AI Gateway (a bare string model like `generateText({ model: "anthropic/claude-sonnet-4.5" })`), the AI SDK stamps `provider: "gateway"`. Solwyn derives the true vendor from the `vendor/model` prefix of the model id, so per-vendor budgets and metadata are attributed correctly instead of collapsing onto `openai_compatible`.

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

<details>
<summary>Coverage policies, strict mode, and CI fingerprints</summary>

Solwyn classifies the public pre-call capability graph of each wrapped provider client.
Tracked leaves are intercepted as usual, while known untracked leaves and newly observed
leaves follow `onUnmetered`: `"warn"` logs once and permits the call, `"raise"` refuses it
before provider I/O, and `"allow"` permits it without warning. In strict mode, use
`acknowledgeUntracked` only for narrow, deliberately reviewed exceptions; an acknowledgment
does not make a whole namespace safe.

Native OpenAI and Azure OpenAI `responses.create`, `responses.parse`, and `responses.stream` are
tracked. Other OpenAI-compatible clients retain their native Responses managers under the
unmetered posture because their wire behavior is not assumed to match OpenAI's native client.

`coverage(client)` computes a local structural report without calling a provider operation or
transmitting data. For CI, pin an independently reviewed literal. This exhaustive strict,
unacknowledged example is reviewed against `openai@6.45.0`:

```ts
import OpenAI from "openai";
import { coverage, type CoverageFingerprint, Solwyn } from "@solwyn/sdk";

const client = new Solwyn(new OpenAI(), {
  apiKey: process.env.SOLWYN_API_KEY!,
  acknowledgeUntracked: [],
  onUnmetered: "raise",
});

const OPENAI_STRICT_FINGERPRINT: CoverageFingerprint = {
  conditional: "sha256:077917c04e6b5e20fd8ccc6a0eb8a580e83fac87669294994d289b2093ea8f18",
  guarded_namespaces: "sha256:a1288a7a5a96886831bbf1db63983f5fc27c2a3a1588a986a7f3f8430185f508",
  tracked: "sha256:901afc09bff7b5d104f6318dbcc2096b22384e3414eb9c60daa9191dc789121a",
  unknown: "sha256:03de074672db9bf0f7847eab1ff9fc62b74c0422f2d4d880a4f60038c0375643",
  blocked: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  unsupported: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  safe: "sha256:937cecc4482b2a7bd34ffd7055356e2ea39405c022748a25ab4916f7136d9e15",
  scoped_escapes: "sha256:0526a31b028ba65707f0e314ea3119a7747c3961b30d9f9cd150658953fd132f",
  untracked: "sha256:3eafdebfab1bd7cd00f2656091950b1cbee7ed89dedc287ff26c730ba0ddf54c",
};

coverage(client).expect(OPENAI_STRICT_FINGERPRINT);
await client.close();
```

When the provider SDK changes, inspect `coverage(client).entries`, review every category
change, and then paste a new literal. Do not derive the expected fingerprint from the same
report used by the assertion; that would make the check tautological. Azure OpenAI has a
different graph and needs its own reviewed fingerprint.

Strict mode is a cooperative pre-call guard, not a sandbox. Retaining the raw provider client,
reaching private wrapper state, acknowledging a scoped raw escape, or invoking behavior on a
returned response, page, stream, job, or operation object can bypass this guard; keep those
capabilities out of code that relies on strict enforcement or review their use explicitly.

</details>

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

On a failover-eligible error the router walks `[primary, ...fallbacks]` in health order. `failoverTotalTimeout` is the failover window: it starts at call entry and gates budget preflight, `Retry-After` sleeps, and whether another hop may start. It does not interrupt a provider request that has already been dispatched. Every attempt instead receives the same `failoverHopReadTimeout` SDK request bound, so worst-case wall time is approximately the failover window plus one provider read bound.

JavaScript provider SDKs expose one per-request timeout rather than separate connect/read controls. OpenAI, compatible clients, and Anthropic receive it in their request options; Google applies it to the whole request through `config.httpOptions.timeout`. Bedrock receives AWS SDK v3 `requestTimeout`, but that carrier is not a universal hard abort for every Converse stream handler. When Solwyn can read no finite-positive socket timeout from a Bedrock client's `requestHandler`, it warns so the handler can be bounded explicitly.

Circuit breakers, latency signals, and failover labeling key off the provider **name** — so give distinct endpoints distinct identities (via `provider` or the 4th fallback element) when you want them tracked separately.

**Selection policy.** Attempt order is chosen by an injectable `selectionPolicy` (the drop-in seam — swapping it changes ordering with zero changes to dispatch, translation, or budgets):

- `HealthBasedPolicy` — health-tier ordering (default).
- `LatencyPolicy` — prefers lower observed p50 latency.
- `CostPolicy` — prefers cheaper providers using server-supplied price hints.

```ts
import { LatencyPolicy } from "@solwyn/sdk";

const client = new Solwyn(new OpenAI(), {
  apiKey: process.env.SOLWYN_API_KEY,
  fallback: [/* ... */],
  selectionPolicy: new LatencyPolicy(),
});
```

Every budget check opts into price hints. The response's hint map is request-scoped and is passed
directly to candidate selection for that call (or replayed from that exact chain's bounded allow-
cache entry); it is never stored as mutable client-wide state. There is no public
`updatePriceHints()` method. `CostPolicy` labels a successful displacement as `cost_routed` only
when a closed fallback is strictly cheaper than a closed primary, or the primary has no hint.
An explicit empty hint map is a priced answer and falls back to health-based ordering without a
warning; a missing hint statement warns once and then uses the same ordering. In either case,
unusable open candidates are removed, the remainder is ordered `CLOSED` → `HALF_OPEN` →
recovery-eligible `OPEN`, and configured order is preserved within an equal health tier.

Lease-backed run calls currently receive no price hints. `CostPolicy` therefore uses that same
health-based fallback until lease grants carry hints.

**Cross-dialect translation.** A failover hop between two clients of the **same** dialect (e.g. Groq → OpenRouter) is a native passthrough. A hop **across** dialects (e.g. OpenAI → Anthropic) runs a minimal canonical translation subset and **fails loud** rather than silently mangling a request: an untranslatable request raises `UntranslatableRequestError`, and a missing target model mapping raises `UntranslatableModelError`. These errors abort the whole chain — they are never swallowed into a retry.

> **Bedrock note.** Bedrock supports failover between Bedrock clients. Failover from another client family into Bedrock raises `UntranslatableRequestError`; use another Bedrock client as the fallback for a Bedrock primary.

**Other knobs:**

| Option | Default | Description |
|--------|---------|-------------|
| `failoverIdempotency` | `"safe"` | Cross-provider hop policy: `"safe"` / `"never"` / `"always"` |
| `sameProviderRetries` | `0` | Same-provider retries on a 429/529 carrying a usable `Retry-After` |
| `failoverTotalTimeout` | `30` | Failover-window seconds for preflight, retry sleeps, and between-hop advancement |
| `failoverHopReadTimeout` | `600` | Constant per-attempt provider request bound in seconds |

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

For a stable run identity that crosses separately scheduled call stacks, create a detached handle
and activate it explicitly:

```ts
import { createRun } from "@solwyn/sdk/node";

const handle = createRun("durable-workflow", { tags: { queue: "billing" } });

await handle.activate(async () => {
  await client.chat.completions.create({ model: "gpt-4o", messages: [/* ... */] });
});

await handle.activate(async () => {
  await resumeWorkflow();
});

handle.finish();
```

`createRun()` does not change the current context. Every `activate(fn)` uses the handle's fixed
`runId` and tracks the exact value or promise returned by `fn`; return or await background work
that must keep the activation alive. `finish()` is permanent and fails while an activation is
still active. A handle cannot recursively activate itself in its own context.

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

<details>
<summary>Run termination and velocity configuration</summary>

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

| Option | Env var | Default | Meaning |
|--------|---------|---------|---------|
| `velocityMode` | `SOLWYN_VELOCITY_MODE` | `"warn"` | `"off"`, `"warn"`, or `"deny"` |
| `velocityRepeatCount` | `SOLWYN_VELOCITY_REPEAT_COUNT` | `5` | Near-identical same-model calls required (2–64) |
| `velocityRepeatWindowS` | `SOLWYN_VELOCITY_REPEAT_WINDOW_S` | `60` | Repeat-matching window in seconds |
| `velocityGrowthStreak` | `SOLWYN_VELOCITY_GROWTH_STREAK` | `8` | Successive calls whose estimated input sizes must strictly increase (3–64) |
| `velocityGrowthFactor` | `SOLWYN_VELOCITY_GROWTH_FACTOR` | `3` | Latest/first estimated-input ratio |
| `velocityAccelFloorPerMin` | `SOLWYN_VELOCITY_ACCEL_FLOOR_PER_MIN` | `30` | Minimum current-minute call count |
| `velocityAccelFactor` | `SOLWYN_VELOCITY_ACCEL_FACTOR` | `3` | Current/prior-minute call-count ratio |

Use the edge-safe exact-ID registry when recovery is intentional:

```ts
import { clearRunTermination, runTermination } from "@solwyn/sdk";

const stopped = runTermination(handle.runId);
if (stopped?.source === "local_velocity") {
  clearRunTermination(handle.runId);
}
```

`clearRunTermination(runId)` is forward-looking. A stream that already latched a stop keeps
aborting; restart that stream after clearing. Exact stop reasons are held in a bounded 256-entry
LRU and never inferred from fingerprints, so churn cannot false-stop another run. Active streams
retain their first stop independently until released.

</details>

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

Outages exercise the configured fail-open posture. Here `openAI` is a caller-owned provider client,
so this example may make a provider request even though its control-plane request stays in process:

```ts
const plane = new FakeControlPlane();
const client = plane.wrap(openAI, { failOpen: true, leaseEnabled: false });
const outage = plane.outage({ requests: 1, path: "/api/v1/budgets/check" });

try {
  await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
  });
} finally {
  outage.end();
  await client.close();
}
```

Operator kills are run-scoped and can be tested without provider dispatch:

```ts
import { RunStoppedError } from "@solwyn/sdk";
import { currentRun, run } from "@solwyn/sdk/node";

const plane = new FakeControlPlane();
const client = plane.wrap(denialOnlyOpenAIClient(), {
  leaseEnabled: false,
  model: "gpt-4o",
});

try {
  try {
    await run("operator-kill-example", async () => {
      const runId = currentRun()?.agentRunId;
      if (runId === undefined) throw new Error("missing run scope");
      plane.stopRun(runId, { reason: "operator_stop" });
      await client.chat.completions.create();
    });
    throw new Error("expected the operator kill");
  } catch (error) {
    if (!(error instanceof RunStoppedError)) throw error;
  }
} finally {
  await client.close();
}
```

The seven reserved magic model names have these exact check and lease semantics. “No lease block”
means a denial response omits lease-authority fields.

| Model | Check | Lease | Run scope |
|-------|-------|-------|-----------|
| `solwyn-test/deny` | Monthly denial in the plane's configured mode | `hard_deny` monthly denial; no lease block | no |
| `solwyn-test/deny-alert` | Monthly denial forced to `alert_only`; dispatch continues | `hard_deny` monthly denial; no lease block | no |
| `solwyn-test/deny-tag` | Tag denial in the configured mode | `eligible=false`, `allowed=true`, `ineligible_reason="scoped_rules_present"` | no |
| `solwyn-test/deny-stopped` | `run_stopped`, forced `hard_deny`, remaining budget 0; no run-control directive | Same `run_stopped` denial; no lease block | yes |
| `solwyn-test/runaway` | First sighting per run is allowed; later sightings deny `agent_run` | Same | yes |
| `solwyn-test/kill` | First sighting per run is allowed; later sightings stop the run with `run_stopped` | Same, including the run-control directive when opted in | yes |
| `solwyn-test/lease-ineligible` | Transparent and allowed | `eligible=false`, `allowed=true`, `ineligible_reason="zero_rate_model"`; no lease block | no |

### Vitest fixtures (explicit opt-in)

The SDK does not auto-register a Vitest plugin and does not depend on Vitest. Keep the following
fixture in your own test suite and opt in by importing it. Each test gets a fresh plane; teardown
closes the denial-only wrapped client even when an assertion fails, then loudly rejects any request
to an endpoint the fake does not implement.

```ts
import { expect, test } from "vitest";
import { denialOnlyOpenAIClient, FakeControlPlane } from "@solwyn/sdk/testing";

function createDenialOnlyClient(plane: FakeControlPlane) {
  return plane.wrap(denialOnlyOpenAIClient(), {
    leaseEnabled: false,
    model: "gpt-4o",
  });
}

type Fixtures = {
  plane: FakeControlPlane;
  client: ReturnType<typeof createDenialOnlyClient>;
};

export const solwynTest = test.extend<Fixtures>({
  plane: async ({}, use) => {
    const plane = new FakeControlPlane();
    try {
      await use(plane);
    } finally {
      expect(plane.unmatchedRequests).toEqual([]);
    }
  },
  client: async ({ plane }, use) => {
    const client = createDenialOnlyClient(plane);
    try {
      await use(client);
    } finally {
      await client.close();
    }
  },
});
```

The exported contract helpers cover a different boundary: they probe a caller-selected
control-plane `fetch` and URL, but they do not create server state. Before running them, the caller
must provision the required denial, lease, and stopped-run state. A fake contract test provisions
that state on `FakeControlPlane`; a live contract test provisions equivalent isolated server state
and passes its live `fetch`, URL, and API key. This keeps the same assertions reusable without
pretending that the double provisions a live service or that a live service is zero-network.

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

Or let `await using` do it:

```ts
await using client = new Solwyn(new OpenAI(), { apiKey: process.env.SOLWYN_API_KEY });
// close() runs at scope exit.
```

The AI SDK middleware handle exposes the same `close()` / `Symbol.asyncDispose` contract.

<details>
<summary>Wrapper compatibility</summary>

The wrapper preserves `instanceof`, `.constructor`, stable method identity, own keys and property
descriptors, and property writes, deletes, and definitions. Solwyn-owned lifecycle members such
as `close()` take precedence. Wrapping an existing Solwyn wrapper again fails synchronously with
`ConfigurationError(field: "client")`.

</details>

## Configuration

<details>
<summary>All constructor options, environment variables, and defaults</summary>

| Option | Env var | Default | Description |
|--------|---------|---------|-------------|
| `apiKey` | `SOLWYN_API_KEY` | *required* | Solwyn project API key (`sk_proj_` + 64 hex) |
| `apiUrl` | `SOLWYN_API_URL` | `https://api.solwyn.ai` | Solwyn Cloud API endpoint |
| `model` | — | — | Model for the primary provider (per-call `model` overrides it) |
| `provider` | — | auto-detect | Provider pin for the primary; bypasses detection, then validates client family |
| `fallback` | — | `[]` | Ordered fallback chain |
| `defaultParams` | — | `{}` | Fill-absent request defaults (per-call kwargs win) |
| `tags` | `SOLWYN_TAGS` | none | Default attribution tags; env form is comma-separated `key=value` |
| `failOpen` | `SOLWYN_FAIL_OPEN` | `true` | Select the fail-open outage posture after applicable retained-denial checks |
| `budgetMode` | `SOLWYN_BUDGET_MODE` | `"alert_only"` | Mode attached to SDK-local outage results; live mode comes from Solwyn Cloud |
| `onUnmetered` | `SOLWYN_ON_UNMETERED` | `"warn"` | `"warn"`, `"raise"`, or `"allow"` for untracked spend surfaces |
| `acknowledgeUntracked` | `SOLWYN_ACKNOWLEDGE_UNTRACKED` | `[]` | Exact reviewed terminal surface tokens; env form is comma-separated |
| `reportUntrackedSurfaces` | `SOLWYN_REPORT_UNTRACKED_SURFACES` | `true` | Send content-free untracked-surface advisories |
| `leaseEnabled` | `SOLWYN_LEASE_ENABLED` | `true` | Enable local run-scoped token leases |
| `leaseOutputBoundDefault` | `SOLWYN_LEASE_OUTPUT_BOUND_DEFAULT` | `4096` | Output-token reservation when a request has no usable cap |
| `selectionPolicy` | — | `HealthBasedPolicy` | Injectable candidate-ordering policy |
| `failoverIdempotency` | — | `"safe"` | Cross-provider failover idempotency policy |
| `sameProviderRetries` | — | `0` | Same-provider `Retry-After` retries |
| `failoverTotalTimeout` | — | `30` | Failover-window seconds; does not cap an in-flight provider read |
| `failoverHopReadTimeout` | — | `600` | Constant provider request bound in seconds |
| `circuitBreakerRecoveryTimeoutJitter` | — | `0.2` | Provider-breaker recovery jitter fraction |
| `circuitBreakerFailureThreshold` | `SOLWYN_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `3` | Consecutive failures before a provider breaker opens |
| `circuitBreakerRecoveryTimeout` | `SOLWYN_CIRCUIT_BREAKER_RECOVERY_TIMEOUT` | `60` | Provider-breaker recovery timeout in seconds |
| `circuitBreakerSuccessThreshold` | `SOLWYN_CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | `2` | Half-open successes required to close a provider breaker |
| `logger` | — | console logger | Injectable `debug`/`info`/`warn`/`error` logger |
| `fetch` | — | `globalThis.fetch` | Caller-owned control-plane transport seam; validated at construction |
| `budgetCheckCacheTtl` | `SOLWYN_BUDGET_CHECK_CACHE_TTL` | `5` | Unscoped allow-cache TTL in seconds; `0` disables caching |
| `budgetCheckTimeout` | `SOLWYN_BUDGET_CHECK_TIMEOUT` | `1` | Budget pre-flight timeout cap in seconds |
| `controlPlaneFailureThreshold` | `SOLWYN_CONTROL_PLANE_FAILURE_THRESHOLD` | `3` | Consecutive outages before the shared control-plane breaker opens |
| `controlPlaneRecoveryTimeout` | `SOLWYN_CONTROL_PLANE_RECOVERY_TIMEOUT` | `30` | Control-plane breaker recovery timeout in seconds |
| `breakerReportingEnabled` | `SOLWYN_BREAKER_REPORTING_ENABLED` | `true` | Publish provider-breaker snapshots |
| `reporterBatchSize` | `SOLWYN_REPORTER_BATCH_SIZE` | `50` | Events per ingest batch |
| `reporterFlushInterval` | `SOLWYN_REPORTER_FLUSH_INTERVAL` | `5` | Background flush interval in seconds |
| `reporterMaxQueueSize` | `SOLWYN_REPORTER_MAX_QUEUE_SIZE` | `10000` | Reporter queue cap; overflow drops oldest |
| `reporterMaxInFlight` | `SOLWYN_REPORTER_MAX_IN_FLIGHT` | `3` | Maximum concurrent batch sends |
| `reporterMaxSendAttempts` | `SOLWYN_REPORTER_MAX_SEND_ATTEMPTS` | `5` | Attempts before retryable telemetry is disposed |
| `reporterRetryBackoffBase` | `SOLWYN_REPORTER_RETRY_BACKOFF_BASE` | `1` | Retry backoff base in seconds |
| `reporterRetryBackoffCap` | `SOLWYN_REPORTER_RETRY_BACKOFF_CAP` | `60` | Retry backoff cap in seconds |
| `reporterShutdownDeadline` | `SOLWYN_REPORTER_SHUTDOWN_DEADLINE` | `5` | Final reporter deadline in seconds; `0` is valid |
| `breakerReportHeartbeat` | `SOLWYN_BREAKER_REPORT_HEARTBEAT` | `60` | Full breaker-report refresh interval in seconds |
| `velocityMode` | `SOLWYN_VELOCITY_MODE` | `"warn"` | Local velocity posture: `"off"`, `"warn"`, or `"deny"` |
| `velocityRepeatCount` | `SOLWYN_VELOCITY_REPEAT_COUNT` | `5` | Near-identical same-model calls required (2–64) |
| `velocityRepeatWindowS` | `SOLWYN_VELOCITY_REPEAT_WINDOW_S` | `60` | Repeat detection window in seconds |
| `velocityGrowthStreak` | `SOLWYN_VELOCITY_GROWTH_STREAK` | `8` | Successive calls whose estimated input sizes must strictly increase (3–64) |
| `velocityGrowthFactor` | `SOLWYN_VELOCITY_GROWTH_FACTOR` | `3` | Latest/first estimated-input ratio |
| `velocityAccelFloorPerMin` | `SOLWYN_VELOCITY_ACCEL_FLOOR_PER_MIN` | `30` | Minimum current-minute call count |
| `velocityAccelFactor` | `SOLWYN_VELOCITY_ACCEL_FACTOR` | `3` | Current/prior-minute call-count ratio |

Env fallback is a **presence check**: an env var is consulted only when the corresponding option is `undefined`. An explicitly-passed `false`, `0`, or `""` always wins over the env var. Client objects, request defaults, routing policies, injected transports, and failover-only knobs remain code-only. Unknown option keys and a present non-function `fetch` fail synchronously with `ConfigurationError`.

Both failover timeout values must be finite, non-boolean numbers;
`failoverHopReadTimeout` must also be positive. A zero `failoverTotalTimeout` is valid and prevents
new work from starting after call entry. JavaScript provider SDKs expose a single per-request
timeout carrier, so `failoverHopReadTimeout` bounds the whole provider request rather than a
separate read phase. In particular, Bedrock's `requestTimeout` is not a universal hard abort for
every Converse stream handler; configure a finite socket timeout on the AWS request handler too.

</details>

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

## Data transparency

The SDK sends content-free call/outcome events to the metadata-ingest endpoint. This table lists
the metadata-event fields; it is not the complete control-plane wire inventory:

| Field | Description |
|-------|-------------|
| `model` | Model name (e.g. `gpt-4o`) |
| `provider` | Provider identifier (`openai`, `anthropic`, `google`, `bedrock`, `groq`, …) |
| `input_tokens` / `output_tokens` | Token counts |
| `token_details` | Breakdown: cached, reasoning, audio, and image input/output tokens; `is_estimated` flags length-based estimates |
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
```

See the public [contributor guide](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/CONTRIBUTING.md)
for the full workflow and public-content policy. Report vulnerabilities through the
[Security Policy](https://github.com/solwyn-ai/solwyn-typescript-sdk/security/policy), not a public
issue.

## License

Apache-2.0 — see [LICENSE](LICENSE).
