# Failover

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#failover).

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

On a failover-eligible error the router walks `[primary, ...fallbacks]` in health order. `failoverTotalTimeout` is the failover window: it starts at call entry and gates budget preflight, `Retry-After` sleeps, and whether another hop may start. It does not interrupt a provider request that has already been dispatched. Every attempt instead receives the same `failoverHopReadTimeout` SDK request bound, so worst-case wall time until a response starts is approximately the failover window plus one provider read bound. That bound does not cover reading a response body or stream on every provider (see the timeout notes under Configuration): for OpenAI, OpenAI-compatible, and Anthropic clients, a body or stream that stalls after its first bytes can outlast it. Pass an `AbortSignal` in the request options, or apply your own idle timeout while consuming a stream, to bound that phase.

For the timeout notes, see [Configuration](configuration.md#constructor-options-and-environment-variables).

JavaScript provider SDKs expose one per-request timeout rather than separate connect/read controls. OpenAI, compatible clients, and Anthropic receive it in their request options. Google receives it as `config.httpOptions.timeout` with native retries disabled; on a `@google/genai` version whose request-signal support Solwyn has verified, Solwyn disables that native timeout and arms its own `AbortSignal` timer instead, which stays armed until the buffered response or the stream finishes. Bedrock receives AWS SDK v3 `requestTimeout`, but that carrier is not a universal hard abort for every Converse stream handler. When Solwyn can read no finite-positive socket timeout from a Bedrock client's `requestHandler`, it warns so the handler can be bounded explicitly.

Circuit breakers, latency signals, and failover labeling key off the provider **name** — so give distinct endpoints distinct identities (via `provider` or the 4th fallback element) when you want them tracked separately.

Caller cancellation never advances to another provider or counts as a provider failure. A
cancelled established stream settles the usage observed so far, using the reservation floor
when usage is missing or malformed. Cancellation of a dispatched request before connection, including
deferred Responses helpers, reports an error with `possibly_succeeded: true`, releases local
funding, and does not confirm usage or record latency. Already-aborted requests skip velocity
detection and budget I/O.
SDK request-deadline aborts still count as provider failures. A half-open streaming
probe is held for at most `circuitBreakerRecoveryTimeout` seconds after setup, with a one-second
minimum. Expiry or finalization releases it neutrally, so an unread stream cannot block later
recovery indefinitely. Its later outcome cannot affect a newer probe.

For established streams, non-429 HTTP 4xx errors are health-neutral; errors without an HTTP
status count as provider failures unless caused by caller cancellation.

`failoverIdempotency: "never"` prevents cross-provider hops, `"safe"` permits only failures
known to be eligible for failover, and `"always"` also permits ambiguous failures after send.
The per-call request field `solwynIdempotent: false` tightens `"always"` to `"safe"` and keeps
`"never"` unchanged; `true` preserves the configured policy. Solwyn strips this field before
every intercepted provider dispatch, including media and Bedrock command input. It never
changes the caller's params or command. When a plan suppresses custom failover tuning, the SDK
uses the stricter requested/default idempotency policy, fewer retries, and smaller total window;
a requested zero window still prevents dispatch.

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
