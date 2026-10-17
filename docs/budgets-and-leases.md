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
Set `leaseOutputBoundDefault` (default `4096`) to change the fallback reservation when a request
does not expose a usable structural output cap.
