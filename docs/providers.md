# Provider reference

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#providers).

## Compatibility

Optional provider peers are bounded to the reviewed major-version intervals:

| Package | Optional peer range | Reviewed boundary or integration cells |
|---------|---------------------|----------------------------------------|
| `openai` | `>=4.41.0 <8` | 4.41.0 and 7.36.0 surface cells; installed native type checks at 6.45.0 |
| `@anthropic-ai/sdk` | `>=0.30.0 <1` | 0.30.0 and 0.135.0 surface cells; installed native type/runtime checks at 0.123.0 |
| `@aws-sdk/client-bedrock-runtime` | `>=3.422.0 <4` | 3.422.0 and 3.1124.0 surface cells |
| `@google/genai` | `>=0.3.1 <3` | 0.3.1 and 2.30.0 surface cells; installed lifecycle checks at 0.3.1 and 2.20.0 |
| `together-ai` | `>=0.16.0 <1` | 0.16.0 and 0.58.0 surface cells |
| `ai` | `>=7.0.14 <8` | Vercel AI SDK integration checks at 7.0.14 |
| `@openai/agents` | `>=0.20.0 <1` | OpenAI Agents HTTP recipe checked at 0.20.0 with OpenAI 7.36.0 |
| `@langchain/core` | `>=1.2.14 <2` | LangChain recipe checks at core 1.2.18, OpenAI integration 1.6.2, LangGraph 1.5.1 |

`@google/generative-ai` has one reviewed surface cell at 0.24.1 and is not an optional peer; do
not infer a supported peer interval from that evidence.

The full unit suite uses the development pins: OpenAI 7.36.0, Anthropic 0.135.0, Google GenAI
2.30.0, and Together AI 0.58.0. Installed-consumer probes retain their independent fixture
versions listed above; refreshing a surface cell does not refresh those fixtures.

Boundary cells are not continuous-version coverage: they do not claim that every intervening
version received every runtime scenario. Only the named cells are release-validated; the manifest
intervals admit other compatible versions within the bounded majors without claiming the same
depth of evidence for each version.

OpenAI 7 requires Node 22 or later. The Solwyn core still supports Node 20; use a compatible
older provider SDK when running on Node 20.

## OpenAI Responses API

For Responses, Solwyn meters `responses.create`, `responses.parse`, and `responses.stream` on
native OpenAI and Azure OpenAI clients. Calls are primary-only: they never enter the fallback or
translation walk. Buffered and streaming calls settle provider-reported Responses usage; missing
or unusable zero usage falls back to the pre-flight estimate and is marked as estimated.

For `responses.parse` and parsed `responses.stream` results, a raw `json_schema` format
produces `unknown` parsed values: narrow them before use, or use a branded helper such as
`zodTextFormat` for schema inference. Optional and union helper formats preserve their parsed
type alongside `null`. This reflects runtime parsing even with older provider declarations
that typed these cases as always `null`. Generic forwarding code can supply an explicit parsed
result type with `responses.parse<Params, Parsed>(params)` or
`responses.stream<Params, Parsed>(params)`.

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

## Anthropic streaming usage

Streaming settles usage from cumulative `message_delta` counters, including input and cache
totals updated by server tools. Aggregate-only deltas preserve the initial five-minute and
one-hour cache split. When the served request's `cache_control` markers specify one TTL
(omitted `ttl` means `5m`) and the initial split has no writes in the other bucket, additional
writes use the requested TTL without marking usage estimated. Otherwise, additional writes
use the initial TTL when exactly one was observed; a known mixed-TTL request marks this split
estimated. If neither signal identifies a single TTL, additional writes use the conservative
one-hour bucket and mark usage estimated. Explicit per-TTL delta counts remain authoritative.
Decreasing aggregate counts retain observed cache writes and mark usage estimated.
When supplied, thinking tokens are reported as a subset of the output total.
Service tiers `standard` and `priority` are preserved; unsupported tiers such as `batch` are
omitted.

`messages.stream` and `messages.parse` are unmetered helpers. With the default
`onUnmetered: "warn"`, each passes through after one warning, with no budget check or cost
event. Use `messages.create`, with `stream: true` for streaming, for metered calls.

## Amazon Bedrock details

Notes:

- Model identity is reported exactly as you pass it — foundation-model ids, cross-region inference profiles (`us.` / `eu.` / `jp.` / `global.` …), or full ARNs — together with the client's region (from `client.config.region`), because Bedrock pricing is keyed per model **and** region.
- Every `InvokeModel*` command, including `InvokeModelCommand`, `InvokeModelWithResponseStreamCommand`, and `InvokeModelWithBidirectionalStreamCommand`, raises `ConfigurationError` instead of bypassing budget tracking (their usage is buried in a consume-once body alongside response content). Use Converse, or call the unwrapped AWS client directly for deliberately untracked calls.
- Any **other** command passes straight through to the wrapped client's native `send`. An unrecognized command that carries `input.modelId` passes through untracked with a one-time warning (never silently).
- The callback form `send(command, callback)` is not budget-trackable on an intercepted command and fails loud — await the returned Promise instead.

## OpenAI-compatible detection

Auto-detected providers (by base-URL host):

| Provider | Detected from |
|----------|---------------|
| xAI (Grok) | `api.x.ai`, `*.api.x.ai` |
| DeepSeek | `api.deepseek.com` |
| Mistral | `api.mistral.ai` |
| Qwen (DashScope) | `dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`, `dashscope-us.aliyuncs.com`, `*.dashscope.aliyuncs.com`, `*.maas.aliyuncs.com` |
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

## Wrapper compatibility

The wrapper preserves `instanceof`, `.constructor`, stable method identity across repeated
direct reads, key and descriptor reflection, and property writes, deletes, and definitions. Solwyn-owned lifecycle members such
as `close()` take precedence. Wrapping an existing Solwyn wrapper again fails synchronously with
`ConfigurationError(field: "client")`.

Key, membership, and descriptor inspection do not count as use of an untracked surface.
Configurable reflected callables and resources enforce the surface policy when used. These
descriptor values are live guarded handles: they follow later replacement of the property,
and a reflected callable can have a different identity from a direct method read.
Traversing an unknown data namespace records the terminal child rather than the container;
a namespace read with no traversal is recorded on the next microtask under `warn` or `allow`.
Native serialization limits, including circular `_client` references, still apply.
`coverage()` accepts wrappers created through either ESM or CommonJS and throws
`ConfigurationError(field: "client")` for an unregistered object.
