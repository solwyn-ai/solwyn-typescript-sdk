# Budget checks, settlement, and run leases

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#budget-enforcement).

Tracked calls obtain budget authority before provider dispatch, using a length-based input-token
estimate. The ordinary check path uses `POST /api/v1/budgets/check`; when it returns a reservation,
the reporter settles it through `POST /api/v1/budgets/confirm` with observed usage. Streaming
settles once, at stream end. Eligible calls can reuse cached authority or a run lease. A hard
deny throws before provider dispatch and reports a `budget_denied` event carrying the estimate.
`budgetCheckTimeout` must be at least `0.1` seconds, including when supplied through
`SOLWYN_BUDGET_CHECK_TIMEOUT`; smaller values fail construction with
`ConfigurationError(field: "budget_check_timeout")`. This minimum leaves setup headroom above
the 50 ms network skip floor. The timeout is shared by a lease attempt and any per-call
fallback, and capped by the remaining failover deadline. With less than 50
milliseconds remaining on that shared deadline, preflight skips network I/O and applies local
policy, logging `budget.preflight_skipped_deadline` at most once per minute per client. This
does not record a breaker failure or draw lease headroom. A caller's request `AbortSignal`
also cancels preflight; cancellation rejects without recording a control-plane breaker
failure. Error abort reasons are preserved; other reasons become an `AbortError`. Direct
`BudgetEnforcer.checkBudget()` callers can pass `signal` and use the returned `callId` to
settle or release a lease reservation, including when the SDK generated the ID.

Settlement is automatic and private. Close the wrapped client to flush queued confirmations
and events; your application does not need a separate confirmation call.

Confirmations run concurrently up to `reporterMaxInFlight` (default `3`), with independent
idempotent call IDs. Metadata batches remain serial. Retryable failures park the FIFO head;
already-active confirmations can finish. Retries honor `Retry-After` (seconds or HTTP-date, up to
one hour) and use exponential backoff with half-to-full jitter. HTTP 429 has a separate cap of
20 responses per pending item. Final confirmation and metadata flushes wait for a server's retry
deadline when it fits within the remaining close budget. Longer holds are counted as `rate_limited` losses;
an unsent settlement confirmation still releases its metadata event for ingestion.

Persistent confirmation failures reach ERROR after ten consecutive failing delivery rounds.
A round uses its last non-neutral confirmation verdict in dispatch order, so completion order
cannot change the count. A success resets it; held admissions and read-only skips do not count.
Lease-funded metadata includes the same `lease_id` as its confirmation. Cache reads and creation
buckets must fit within input tokens; wrapped provider clients preserve those buckets and raise an
inconsistent input total to their sum, marking it estimated. This correction settles the adjusted
observed usage without retaining the lease reservation floor. Ingest responses require `ingested`,
`rejected`, and `duplicates`; malformed responses produce contract-drift diagnostics while usable
rejection dispositions are still logged.

**Run-scoped leases.** With `leaseEnabled: true` (the default), an untagged text call inside a
Node `run(...)` or `RunHandle.activate(...)` scope can reserve estimated input plus an output bound
from a local run lease. That removes a control-plane round trip from most calls while the lease is
live. Grants and renewals are generation-fenced; renewal is detached from the call path, and
`close()` surrenders remaining authority best-effort after queued telemetry is flushed. Tagged
calls, media calls, ineligible models, and calls outside a run keep the ordinary per-call check.
A lease first covers the model chain of the call that acquired it. When a per-call check allows a
call on a chain the lease does not cover, the SDK renews the lease in the background with that
call's full chain (model, provider and fallbacks), and later calls on the chain use the lease.
The control plane prices the widened lease at its most expensive model, so widening to a pricier
model shrinks every model's grant. If it answers the widening as ineligible, the models it added
stay on per-call checks for the rest of the run and are never declared again.
If a grant is refused with 409, or a renewal comes back ineligible, the run uses per-call checks
for at most 150 seconds; after an ineligible renewal the SDK releases its lease and acquires a
new one as soon as the release is confirmed. An ineligible initial grant keeps the run on
per-call checks.

**Output bound.** Every text call reserves estimated input plus an output bound, on both the
lease and the per-call path. The per-call check sends it as `estimated_output_bound`, and Solwyn
Cloud prices that many output tokens at the model's output rate. A positive cap you set is the
per-candidate cap: `max_tokens`, `max_completion_tokens`, Responses `max_output_tokens`,
Anthropic `max_tokens`, Google `config.maxOutputTokens`, Bedrock `inferenceConfig.maxTokens`, or
AI SDK `maxOutputTokens`, including caps from `defaultParams`. With no cap, the per-candidate cap
is `leaseOutputBoundDefault` (default `4096`). The bound is that cap times the candidate count
(OpenAI `n`, Google `config.candidateCount`). For Qwen, whose `max_tokens` leaves reasoning out,
the bound also adds `thinking_budget` per candidate. With failover, the bound is the largest any
configured hop can use. A bound above 100,000,000 is sent as 100,000,000.

On a hard_deny project, Solwyn holds each call to its bound or refuses it. This applies when a
hard_deny check allows the call, or when it draws on a lease with a hard_deny posture. Just before
each provider request, the SDK checks the final request. An uncapped request gets
`leaseOutputBoundDefault` as its cap, because a call with no output limit cannot honestly be held
to a hard budget cap. Set your own cap to choose a different limit. If the request could still
produce more output than the bound, the call fails before it reaches the provider with
`OutputBoundUnenforceableError` (`code: "output_bound_unenforceable"`). The error's `reason` and
`hint` say what to change:

| `reason` | When |
|---|---|
| `malformed_cap_container` | Google `config` or Bedrock `inferenceConfig` or `additionalModelRequestFields` is not an object |
| `malformed_candidate_count` | `n` or `candidateCount` is not a positive integer |
| `reasoning_without_budget` | Qwen with thinking not turned off (`enable_thinking: false`) and no positive `thinking_budget`; an xAI reasoning model (xAI caps leave reasoning out and take no budget); Qwen or an xAI reasoning model through the AI SDK |
| `client_body_override` | a Google client's `httpOptions.extraBody` sets `generationConfig`; Bedrock `additionalModelRequestFields` sets a token limit or count; AI SDK `providerOptions` set a token limit or count |
| `azure_api_version` | an uncapped Azure OpenAI call on an api-version older than 2024-09-01 |
| `bound_exceeded` | the final request can still produce more than the bound, for example a cap above 100,000,000 |

Azure OpenAI gets `max_completion_tokens`, which api-versions from 2024-09-01 accept for every
chat deployment. A deployment name never selects the parameter, and an explicit
`max_completion_tokens` is never rewritten to `max_tokens`. OpenAI, Azure OpenAI, Anthropic,
Gemini, and Bedrock count reasoning inside the cap. Nothing changes on alert-only projects, and an
SDK-local outage decision never adds a cap: those calls reach the provider exactly as you built
them.

Known limitations: a scoped hard_deny rule on an alert-only project does not show in the check's
`mode`, so uncapped calls under that rule are not capped and one call can still overshoot it. A
Qwen model that thinks even with `enable_thinking: false` is bounded without its reasoning.
DeepSeek, Groq, Mistral, Z.ai, Perplexity, and Fireworks are treated as counting reasoning
inside the cap; their docs do not say so explicitly.