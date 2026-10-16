# Changelog

All notable changes to `@solwyn/sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`0.x` releases are a public preview. Breaking changes are called out in this changelog and the
corresponding release notes before users upgrade.

## [Unreleased]

### Changed

- **Breaking: closed clients reject intercepted calls.** Once `close()` begins, chat,
  Responses, media, and Bedrock calls reject with `SolwynError("client is closed")` before
  admission or provider dispatch. Buffered calls and stream setup already in flight drain
  within `reporterShutdownDeadline`, sharing that deadline with settlement delivery. Open
  streams settle once from usage observed so far without waiting for the consumer; later
  chunks are withheld at the next provider-chunk boundary. Finish or cancel streams before
  closing the client to include terminal usage. Calls that outlast the drain deadline may
  finish after reporting closes, and produce a shutdown warning.
- **Conservative failover limits.** When a plan suppresses custom failover tuning, the SDK
  preserves the stricter requested idempotency policy, smaller total failover window, and
  lower retry count instead of loosening them to defaults.
- **Per-call idempotency only tightens policy.** `solwynIdempotent: false` limits a call to
  `"safe"` failover while preserving a configured `"never"`; `true` preserves the configured
  policy. The option is stripped from every intercepted request, including media and native
  Bedrock commands, without mutating caller-owned params.
- **Breaking: numeric configuration rejects unsafe values.** Budget-check and reporter timers
  must be finite, non-boolean durations within 2,147,483,647 milliseconds; positive timers
  reject zero, while cache TTLs, recovery waits, the total failover window, and shutdown deadlines
  allow zero and reject negatives. Empty numeric environment values are rejected. Breaker
  thresholds must be positive integers, retries must be non-negative integers, and jitter must
  be between zero and one. Reporter batches cannot exceed 1000 events, and breaker heartbeats
  cannot exceed 60 seconds. Documented defaults are unchanged.
- **Direct budget-enforcer durations are validated.** `BudgetEnforcer` now rejects non-number,
  non-finite, negative, and oversized `cacheTtl` values, and non-number, non-finite, non-positive,
  and oversized per-call `timeout` values with `ConfigurationError`. Both durations are in
  seconds and must fit a timer delay of at most 2,147,483,647 milliseconds.
- **Velocity history survives higher run concurrency.** Structural loop detection now keeps
  compact histories for up to 4096 runs and discards stale histories first. At the hard cap,
  established histories continue progressing through round-robin traffic; discarding live
  history emits a rate-limited `velocity.history_evicted` warning.
- **Run lifetime tracking starts on demand.** Importing the Node entry no longer enables a
  process-wide async hook. Tracking starts with the first callback run or detached handle and
  stops when the last run lifetime is collected. Active lifetimes still add promise overhead.
- **Surface reflection is observational.** Key, membership, and descriptor inspection no longer
  applies untracked-spend posture. Configurable reflected operations enforce policy when used;
  their descriptor values are live guarded handles, and reflected callable identity can differ
  from a direct read. Fixed descriptors preserve native Proxy invariants. Unknown data namespaces can be traversed
  in strict mode, and `warn`/`allow` record only the terminal child, or a bare namespace on the
  next microtask. Surface reads reuse attribution until mutation or initialization refreshes it.
- **Typed coverage errors.** In this public preview, `coverage()` now throws
  `ConfigurationError(field: "client")` instead of `TypeError` for an unregistered object.
- **Helper coverage guidance.** The README now explicitly identifies Anthropic
  `messages.stream`/`messages.parse` and OpenAI Chat Completions `stream`/`parse`/`runTools`
  helpers as unmetered, with no budget check or cost event under the default warning posture.

- **Bounded lease surrenders.** Lease surrenders now go through one dispatcher per client, with
  at most four requests in flight and 64 waiting. Finished runs are surrendered as runs end, not
  by scanning every retained run on each provider call. A surrender that is refused (any 4xx or
  5xx answer), overflows the queue, or passes its deadline is dropped and counted, and the drops
  are reported in aggregated `lease.surrenders_dropped` warnings, instead of being retried on
  every call. The control plane settles spend from lease-tagged confirmations, so a dropped
  surrender only delays the return of unspent reserved tokens until the lease expires.
- **Surrender timeout retry.** Outside `close()`, a surrender that times out is now retried once,
  immediately, within two seconds of being queued. Surrender answers with an HTTP status (4xx or
  503) still count as control-plane reachability for the circuit breaker.
- **Close drains through four workers.** `close()` now drains lease surrenders through four
  workers within its existing one-second deadline, one attempt each, and logs how many were left
  in a single `lease.close_release_summary` warning.
- **Uncounted tallies of finished runs.** Uncounted fail-open tallies can be reported only on a
  lease renewal, which a finished run never sends. They are now aggregated and logged in
  `lease.uncounted_discarded` warnings (at most one every 30 seconds, repeated in the close
  summary) instead of being retained indefinitely. The `lease.uncounted_entry` warning now says
  so.
- **Lease recovery after a refusal.** After a lease grant is refused with 409, or a renewal comes
  back ineligible, a run now falls back to per-call budget checks for at most 150 seconds,
  instead of for the rest of the run. After an ineligible renewal, the SDK releases the lease it
  holds and acquires a new one as soon as the release is confirmed; the new lease's renewals no
  longer repeat the refused renewal's spend or uncounted tallies. An ineligible initial grant
  still keeps the run on per-call checks. The `FakeControlPlane` test double in
  `@solwyn/sdk/testing` now accepts that release, at the generation held before an ineligible or
  denied renewal, as the control plane does, instead of answering 409.
- **Run leases widen to newly used model chains.** A run lease used to cover only the model chain
  of the run's first call, so every call on another model or fallback chain took a blocking
  per-call budget check for the rest of the run. Now, after a per-call check allows a call whose
  chain the lease does not cover, the SDK renews the lease in the background and re-declares that
  call's full chain (model, provider and fallbacks); once the renewal is applied, later calls on
  that chain use the lease. A denied, unreadable or unreachable check never widens the lease, and
  tagged and media calls never do. If the control plane answers the widening renewal as
  ineligible, the models it added are recorded for the run and never declared again: calls whose
  chain names one of them keep per-call checks, and the rest of the run returns to the lease after
  the SDK releases and re-acquires it. Widening to a more expensive model re-prices the lease for
  every model in the run, so each model's token grant shrinks.
- **Concurrent settlement confirmations.** `reporterMaxInFlight` now limits confirmation POSTs
  (three by default); metadata batches remain serial. A retrying FIFO head holds later dispatch
  while already-active confirmations finish independently. For ERROR escalation, a round fails
  when its last non-neutral confirmation verdict in dispatch order fails. A successful last
  verdict resets the counter; held admissions and read-only skips leave it unchanged. ERROR
  begins at ten consecutive failing rounds, independent of completion order.
- **Rate-limit-aware retries.** Reporting honors delta-seconds and HTTP-date `Retry-After`
  headers, bounded to one hour, including during shutdown. HTTP 429 responses have a separate
  twenty-response cap instead of consuming ordinary send attempts. Confirmation, ingest,
  provider-breaker, and untracked-surface retries use bounded exponential backoff with
  half-to-full jitter. Ingest and provider-breaker reports share a project rate-limit hold.
- **Current settlement wire contract (preview breaking).** Ingest responses now require a strict
  `duplicates` disposition list. Metadata accepts an optional, nullable `lease_id` up to 64
  characters. Lease renewals require model and provider together, and fallback declarations
  require that primary pair. The reviewed endpoint snapshot and its contract tables now include
  duplicate dispositions, lease metadata, ingest availability responses, and unsupported-media
  errors.
- **Server-faithful testing verdicts (preview breaking).** `FakeControlPlane` now allows project
  overruns in `alert_only` mode with a reservation and negative remaining budget, including
  `solwyn-test/deny-alert` checks and leases. Scoped and run denials use `hard_deny`. Lease
  `postureMode` can model independent scoped enforcement; `final_grant` applies only to a hard
  posture. Opted-in text checks provide price hints, legacy checks omit directive keys, and all
  opted-in stopped-run verdicts include the directive. `stopRun()` accepts only `manual_kill`;
  `runUsage` supplies explicit synthetic stopped-run spend. Default lease timers are 120 seconds
  with a 15-second refresh.
- **Server-faithful testing ingestion (preview breaking).** The test double returns duplicate
  dispositions and stores only accepted events; scripted count rejections now carry indexes.
  It rejects metadata batches above 1,000 events, duplicate untracked keys in one batch,
  untracked bodies above 256 KiB, and breaker reports outside the key's project. A stopped run
  is checked before replaying an existing holder's grant.

### Added

- **Effective call IDs on budget results.** `BudgetEnforcer.checkBudget()` returns `callId`,
  including an ID minted when the caller omits one, so direct callers can settle or release
  the corresponding lease reservation. `CheckBudgetOptions.signal` adds caller cancellation.

### Fixed

- **Caller cancellation preserves provider health and observed usage.** Buffered and stream
  setup aborts never fail over or count as provider failures. Mid-stream cancellation settles
  observed usage once, using the reservation floor when usage is estimated, including Google
  reader errors, Bedrock aborts, and native Responses helpers. SDK request-deadline aborts
  remain provider failures. Other stream errors now follow the exception classifier, so
  request errors release recovery probes without a health penalty.
- **Unread recovery streams release probe ownership.** A half-open streaming probe is held for
  at most `circuitBreakerRecoveryTimeout` seconds after setup, with a one-second minimum. Expiry
  or finalization releases the probe neutrally; stale outcomes cannot affect later probes.
  Terminal stream health still decides recovery when it arrives within that bound.
- **Run stops retain usage from the pulled chunk.** Stream accumulators observe usage before
  checking a latched stop, including terminal usage events on native Responses helpers.
- **Consumer stream throws settle observed usage.** Iterator `throw()` now follows the same
  settlement and cleanup path as early return, forwards the consumer error to the underlying
  iterator where supported, and rethrows it without counting a provider failure.
- **Constructor shape errors are typed and synchronous.** Invalid options objects, fallback
  lists, model values, loggers, and selection policies raise `ConfigurationError` before
  reporters or budget resources start.
- **Budget preflight shares one deadline and honors cancellation.** An initial lease attempt
  and its per-call fallback now share the requested timeout. An exhausted deadline skips the
  fallback without adding a breaker failure. Caller `AbortSignal`s reach preflight transport;
  already-aborted requests skip budget I/O, and cancellation rejects without treating it as a
  control-plane outage.
- **Completed calls release lease bookkeeping immediately.** Settlement, release, and unknown
  usage no longer retain a full claim and expiry entry for 900 seconds. Per-call budget results
  release their unused lease claims, and a bounded recent-ID history still rejects accidental
  call-ID reuse.
- **Late lease settlements remain accounted for.** After the 900-second reservation sweep
  refunds an abandoned reservation, a matching late settlement debits its full usage against
  the original lease. The SDK retains at most 4096 swept reservations and fences settlements
  from replacement lease incarnations.
- **Lease reports contain only their own spend.** Dropping or replacing a lease clears its
  advisory spend tally so a successor lease's renewal or surrender cannot report the old burn.
- **Lease outage admissions accrue local estimates.** Calls admitted against the outage share
  or after lease expiry now accrue the fixed estimate in the current UTC-day bucket. Per-call
  outage checks use that shared spend, and a server's fail-open lease posture cannot relax a
  client's `failOpen: false` setting.
- **Complete Anthropic usage.** Streaming input and cache totals now follow cumulative
  `message_delta` counters, including server-tool usage. Buffered and streamed usage map
  thinking tokens without adding them twice to output, and preserve reported service tiers.
- **Google sizing and omitted zero counters.** Preflight estimates include Content `parts` and
  `config.systemInstruction`. A measured input total with omitted candidate output tokens is
  treated as reported usage with zero candidate output, including thinking-only responses.
- **Client-local provider diagnostics.** Adapter warnings and local-port detection messages use
  the client's injected logger. Missing-usage warning latches are independent between clients,
  and compatible streams bound and warn about an overlong service tier only at settlement.
- **Cross-dialect stream compatibility.** Bedrock results retain only the metered `stream` when
  served by another dialect, and empty OpenAI `tool_calls` arrays no longer abort translation.
- **AI SDK accounting and attribution.** Middleware maps aggregate cache writes to the
  five-minute bucket, bounds cache buckets by input totals, and estimates a missing usage total
  while retaining its reported counterpart. Vertex Anthropic, LM Studio, vLLM, generic
  compatible clients, and Alibaba gateway models receive their own provider attribution.
- **AI SDK run stops.** Middleware refuses dispatch after a concurrent run stop and aborts
  in-flight streams at the next chunk boundary. A stopped stream keeps its termination across
  `clearRunTermination()`; local velocity detection remains unsupported by this integration.
- **Shared coverage and explicit Node imports.** ESM and CommonJS builds share wrapper coverage
  registrations. Built Node entries preserve the `node:async_hooks` prefix; core entries remain
  free of Node builtin imports. Surface-rule validation also avoids compiling a regular
  expression for every rule during import.

- **Healthy control-plane refusals.** Confirmation 4xx and 503 responses count as reachability,
  matching lease operations, so terminal confirmation refusals cannot open the shared breaker.
- **Reliable untracked-surface reports.** Closing flushes unsent occurrences without the normal
  fifteen-minute gate and uses the configured reporter shutdown deadline. Retries keep the same
  report ID, occurrence count, and cursor; later observations form a separate report. Refused
  keys stop retrying, failures produce rate-limited diagnostics, and read-only credentials use
  the shared configuration diagnostic. Reads with nothing due use a constant-time schedule check.
- **Provider-health heartbeat recovery.** A failed unchanged heartbeat remains due for a normal
  backoff retry before the server's snapshot expires. Reports allow ten seconds for delivery and
  use strictly increasing per-provider timestamps even if the wall clock stalls or rolls back.
- **Bounded queue and timer overhead.** Report queue overflow, prefix restoration, and draining
  now avoid array reindexing. Large flush and close timer delays are clamped to the runtime's
  signed 32-bit timer bound.
- **Strict ingest diagnostics.** Successful ingest bodies are validated before dispositions are
  applied. Missing fields, extra keys, and unknown rejection codes count as contract drift;
  an explicitly logged fallback still surfaces usable per-event rejections.
- **Lease reconciliation and cache usage.** Every lease-funded settlement's metadata now carries
  its confirmation's lease ID, including when the confirmation is abandoned. Overlapping cache
  buckets are clamped to the input total and marked estimated during normalization; unnormalized
  invalid cache breakdowns are rejected locally before they can invalidate a whole ingest batch.
- **Allowed alert-only overrun warnings.** A live allowed response at or above its budget limit
  now produces the budget warning while retaining the reservation for settlement.
- **Gateway-prefixed contract probes.** Testing contract helpers append endpoint paths to the
  configured API prefix using the same URL join as runtime transport.
- Metadata ingestion no longer starves under sustained confirmation traffic. The background
  reporter now delivers in bounded rounds: each round confirms at most one batch's worth of
  standalone confirmations and of settlements, then sends the metadata batches that were queued
  when the round reached them. When a round stops at its quota with work still due, the next round
  starts on the following timer turn instead of after the flush interval.
- `close()` no longer evicts ready metadata events from a full queue while a delivery round that
  was already in flight finishes.
- Clients dropped without `close()` no longer keep their provider, timers and heartbeats alive.
  Once such a client's queued confirmations and events are delivered, its wrapped provider, lease
  state and background reporter can be garbage-collected, its flush timer and provider-breaker
  heartbeats stop, and it leaves the Node exit registry. A client constructed inside `run()` no
  longer keeps that run alive. Reuse one client and `close()` it at shutdown: that remains the
  supported lifecycle.
- **Faster image translation for cross-dialect failover.** Byte-backed Bedrock images are now
  Base64-encoded in bounded chunks (or with the runtime's native `Uint8Array.prototype.toBase64`
  where available) instead of one string concatenation per byte. A 3 MiB image no longer blocks
  the event loop for over 100 ms before the fallback request is dispatched. The encoded output
  is unchanged.
- **Lower per-event CPU for Azure OpenAI Responses streams.** The OpenAI-compatible length
  estimator no longer throws and discards an internal `TypeError` for every Responses stream
  event, which has no `choices`. Settlement is unchanged.
- **Wrapped streams no longer keep completed response payloads or request messages
  reachable.** A held OpenAI stream now retains only the terminal usage block and service tier,
  not the whole terminal chunk or Responses snapshot (with its generated output and echoed
  instructions and tools). A held Google stream releases its buffered first chunk once it is
  delivered or the stream is closed. An unfinished wrapped stream no longer keeps the request's
  messages and options alive. Delivered events, settlement, and
  `responses.stream().finalResponse()` are unchanged.
- **Unread control-plane response bodies are released within the request deadline.** Error
  bodies and the success bodies of lease surrender, settlement confirmation, breaker reports and
  untracked-surface reports are no longer left open until garbage collection, which could hold
  connections and, with a connection-capped HTTP pool, make later control-plane requests time
  out. A small complete body is read to the end so its connection is reused; a larger, stalled
  or failing body is cancelled within the lesser of the remaining request deadline and one
  second. Outcomes are still decided when headers arrive and never wait for this cleanup; body
  bytes are never retained or logged.
- **Merged-tag clamping warns once per client.** When configured, run, and per-call tags merge
  to more than 10 keys, the first clamped call on a client still logs a warning; later clamped
  calls on that client log at debug level with a running count instead of warning on every
  call. Which tags are kept is unchanged.
- **Wrapped methods follow raw method replacement.** A wrapped surface method (for example
  `chat.completions.list`) that is replaced directly on the raw client object, or patched on its
  prototype, after it was first read through the wrapper now calls the new function instead of
  the stale bound original. Reads of an unchanged method still return the same function.
- **Caller aborts end same-provider `Retry-After` waits.** With `sameProviderRetries` above zero,
  aborting the request's `AbortSignal` during a `Retry-After` sleep now rejects immediately with
  the signal's reason (or an `AbortError`), clears the timer, and neither re-dispatches to the
  same provider nor fails over to a fallback, even when the provider SDK ignores the signal.
  Previously the SDK slept for the whole `Retry-After` interval and then dispatched again.
- **Documented what `failoverHopReadTimeout` bounds.** The README no longer says it bounds the
  whole provider request. For the OpenAI, OpenAI-compatible, and Anthropic SDKs it covers
  connecting and receiving headers only, so a stream that stalls after its first bytes is not
  interrupted; Google keeps the bound until the response or stream finishes (through Solwyn's
  own `AbortSignal` timer on a verified `@google/genai` version, otherwise the native
  `config.httpOptions.timeout`). Use an `AbortSignal` or an idle timeout to bound stalled
  streams.

## [0.1.0-rc.1] — 2026-09-11

Bootstrap release candidate for the initial public preview of a drop-in wrapper for an existing
LLM client that enforces budgets, handles failover, and reports usage metadata to the Solwyn Cloud
API. This prerelease is intended for npm's `next` tag after bootstrap publication; it is not
available from the registry until that publication completes. Cloud owns real provider/model
pricing. The SDK's fixed `$0.00003 × estimated input tokens` calculation is used locally for outage
decisions/bucketing and for the `estimatedCost` diagnostic on denial errors, including live Cloud
denials; it is never provider/model pricing.

Your LLM calls go directly to your provider. Solwyn receives usage and operational metadata,
plus tags you explicitly supply. Prompt and response content is not sent to Solwyn or logged by
the SDK. The drop-in client inspects content locally only for length-based estimation and
cross-dialect translation; explicit tags are transmitted verbatim and must not contain sensitive
data.

### Added

- **Drop-in `Solwyn` client.** An ES `Proxy` preserves the wrapped client's TypeScript request
  types and runtime surface while intercepting metered operations. Explicit `close()` and
  `Symbol.asyncDispose` (`await using`) flush state and forward provider shutdown.
- **Provider matrix.** Native OpenAI, Anthropic, Google Gemini, Amazon Bedrock, and Together AI,
  plus named OpenAI-compatible profiles and a generic catch-all. Detection is duck-typed with
  zero runtime provider-SDK imports. Explicit provider pins bypass detection and synchronously
  validate the pinned client family. Optional peers are bounded to reviewed majors: OpenAI
  `>=4.41.0 <7`, Anthropic `>=0.30.0 <1`, Bedrock Runtime `>=3.422.0 <4`, Google GenAI
  `>=0.3.1 <3`, Together AI `>=0.16.0 <1`, and Vercel AI SDK `>=7.0.14 <8`. The separate Google
  Generative AI 0.24.1 surface is one reviewed evidence cell, not an advertised peer dependency.
  Floor/latest cells are boundary evidence, not continuous-version coverage of every intervening
  release.
- **OpenAI Responses metering.** Native OpenAI and Azure OpenAI `responses.create`,
  `responses.parse`, and the deferred `responses.stream` helper locally inspect content length
  when estimation is needed and emit only derived counts. They settle buffered or terminal-stream
  usage. Responses calls are primary-only; background create, streaming parse, and second-argument
  `body`/`query` overrides fail before budget or provider I/O.
- **Streaming** across every supported dialect, settling from terminal usage events and using a
  marked length estimate when a compatible provider reports no usable usage.
- **Budget enforcement.** Pre-flight checks, post-call settlement, Cloud-returned `alert_only` /
  `hard_deny` modes, fail-open/local-enforcement outage policy, and authoritative hard-deny
  retention. Live Cloud response mode governs live blocking; constructor `budgetMode` labels local
  outage results only. When the budget service is unreachable, `failOpen: true` allows after
  retained-denial checks and accrues the fixed estimate in a UTC-day local bucket.
  `failOpen: false` denies without a prior successful budget snapshot, but with a known limit can
  allow while accrued local estimates plus the new estimate remain within the last-known limit.
- **Run-scoped token leases.** Untagged text calls inside Node run scopes can admit locally,
  renew off the call path, and surrender outstanding authority during close. Media, tagged,
  unscoped, and ineligible calls keep per-call checks.
- **Failover and routing.** Ordered fallback chains, per-provider circuit breakers, same-provider
  `Retry-After` retries, whole-chain deadlines, request bounds, idempotency policy, same-dialect
  passthrough, and minimal fail-loud cross-dialect translation. `HealthBasedPolicy`,
  `LatencyPolicy`, and `CostPolicy` are injectable.
- **Request-scoped price hints.** Every budget check opts into server hints; `CostPolicy` can
  attribute a strictly cheaper healthy displacement as `cost_routed` directly from those hints,
  without mutable client-wide hint state.
- **Provider-surface controls.** `onUnmetered`, exact `acknowledgeUntracked` tokens,
  content-free advisory reporting, local `coverage()`, and independently reviewed fingerprints
  protect newly exposed spend surfaces.
- **Agent runs.** Callback `run(name, fn)` and detached `createRun(name)` /
  `RunHandle.activate(fn)` / `finish()` APIs in `@solwyn/sdk/node`, with inherited client/run/call
  tag layers.
- **Run control.** Versioned server stop directives and bounded, content-free local velocity
  detection stop later dispatches and already-returned streams cooperatively. `RunStoppedError`
  derives directly from `SolwynError`, not `BudgetExceededError`; `clearRunTermination(runId)`
  intentionally clears only future work.
- **Denial receipts.** Reporter loss and whole-batch ingest rejection fold denied accounting into
  bounded aggregates that replay after a clean cycle or once during close. Replays use fresh
  identities and expose exact represented cardinality in telemetry/drop accounting.
- **Non-text modalities.** Primary-only budget and usage lifecycle for supported embedding,
  image, audio, and video methods. Local estimators inspect content lengths or structural media
  quantities when needed and emit only derived counts, bounded selectors, and explicit unpriced
  outcomes.
- **Vercel AI SDK middleware** from `@solwyn/sdk/ai-sdk`, including AI Gateway vendor
  attribution.
- **Testing entry.** `@solwyn/sdk/testing` provides the zero-network `FakeControlPlane`, scripted
  scenario windows, seven reserved magic models, reusable contract probes, and a denial-only
  provider sentinel without a test-framework dependency.
- **Edge-safe core.** The main entry uses web-standard APIs and no `node:*` modules; Node-only
  run context stays behind `@solwyn/sdk/node`. The installed manifest retains Node.js 20 only as
  an end-of-life legacy provider-free core lane; full development and release lanes are Node.js
  22 and 24, and the AI SDK 7 integration requires Node.js 22 or newer.
- **Privacy firewall.** Content-touching code is path-restricted and structurally tested. Only
  content-free usage, structural operational metadata, and explicit caller-provided tags leave
  the process; callers must not place sensitive content in tags.
- **Typed errors and strict wire models.** Runtime failures use `SolwynError` subclasses, and
  API payloads use zod 4 strict schemas. The control-plane `fetch` seam and `FetchLike` type are
  public and validated at construction.

### Changed

- Wrapper reflection and mutation now remain transparent: `instanceof`, `.constructor`, stable
  method identity, own keys/descriptors, property writes/deletes/definitions, and wrapped-client
  close forwarding behave like the provider client. Double wrapping fails synchronously.
- Price hints are scoped to the budget result for one call (or that exact allow-cache entry).
  A missing hint statement warns once for `CostPolicy`; an explicit empty map is a valid priced
  answer and stays silent.
- Failover timeouts reject booleans and non-finite values. A zero total window remains legal,
  while the per-hop request bound must be positive.
- Explicit attribution tags merge in per-call → run → client order, are bounded, and bypass run
  leases so tag policy remains authoritative. `solwyn_tags` is removed only from intercepted
  provider requests.
- `run_stopped` is a run-control outcome with its own error hierarchy and exact-ID registry;
  ordinary budget denials still preserve the server's `denied_by_period` label.
- Outage retention follows the denial's authority: project-period hard denials are global,
  `agent_run` denials and stops are exact-run, and tag-period denials are not retained for future
  calls. A response carrying another run's directive enforces its ordinary verdict for that call
  without retaining the tainted composite; a foreign `run_stopped` response uses the outage path.
- Reporter shutdown is bounded and retries use capped backoff. Rejected ingest indexes are
  dispositioned without silently losing denial accounting.

### Fixed

- Native stream `tee()` and readable conversion share metering, translation, run stops, and
  settlement. Closing an unread OpenAI or Anthropic stream cancels its underlying request.
- Native Together embedding, image, speech, and transcription operations enforce budgets and
  settle media usage. Descendant acknowledgments cannot authorize an unguardable parent after
  mutation, and instrumented Bedrock Runtime subclasses retain automatic detection.
- Structural response translation failures retain measured paid usage and consumed authority.
  Google shorthand input preserves supported content, and translated Google calls retain the
  target's HTTP settings without forwarding source credentials.
- SDK error families remain catchable across ESM/CommonJS entry points. Deferred Responses
  helper states and declarations match the supported runtime surface.
- Budget failures and contract probes use fixed safe diagnostic labels, including when injected
  transport errors contain hostile accessors or reflection traps.

- Admission now checks the exact structural request sent to the provider. Payload overrides
  fail before I/O, endpoint credentials stay with their provider during failover, and per-call
  output caps override defaults consistently across native and translated requests.
- Google translation and metering use native TypeScript field names; tool exchanges support
  completed ID reuse, and Anthropic disabled tool choice emits a valid configuration.
- Mixed ESM/CommonJS imports share run enforcement and wrapper identity. Node initialization
  survives tree-shaking, reflected setters refresh bindings, and provider declarations retain
  overloads and generic inference while accurately exposing plain-promise methods.
- AI middleware includes explicit run tags in admission and receipts. Unknown paid usage keeps
  conservative token accounting while preserving the successful provider response.
- Stream cancellation closes the original native iterator once. Run stops cover Responses
  subscriptions and late event waiters; terminal failures count once per logical provider call.
- Breaker results belong to their admission, including delayed results during recovery.
  Native pre-send failures permit safe fallback; ambiguous failures remain conservative, and
  throwing error accessors or loggers cannot replace the authoritative result.
- Distinct metadata events use microsecond timestamps compatible with the existing API
  deduplication key; retries retain stable event identity.
- Completed run state becomes reclaimable while active calls, streams, background resources,
  unfinished handles, pending renewal and unreported spend retain their required ownership.
- Translation errors use fixed structural labels for unknown caller-controlled fields and
  discriminators, resolving the inherited privacy contradiction without echoing content.

### Removed

- Removed the preview-level public `BudgetEnforcer.confirmCost()` method. The client and reporter
  own all reservation/lease settlement.
- Removed the public `updatePriceHints()` mutation API and client-wide hint store.
- Removed `js-tiktoken` and exact-tokenizer loading. Estimation is always heuristic and
  length-based; provider-reported usage remains settlement truth.

### Known limitations

- Lease-backed run calls currently carry no price hints, so `CostPolicy` falls back to
  health-tier ordering (with configured order preserved within equal tiers) until lease grants
  carry hints.
- JavaScript provider SDKs expose one per-request timeout carrier. `failoverHopReadTimeout`
  therefore bounds the whole provider request rather than a separate read phase; Bedrock's
  `requestTimeout` is not a universal hard abort for every Converse stream handler.
- Intercepted OpenAI and Anthropic calls return plain promises rather than `APIPromise`, so
  `.withResponse()` / `.asResponse()` are intentionally unavailable on those calls.

[Unreleased]: https://github.com/solwyn-ai/solwyn-typescript-sdk/compare/v0.1.0-rc.1...HEAD
[0.1.0-rc.1]: https://github.com/solwyn-ai/solwyn-typescript-sdk/releases/tag/v0.1.0-rc.1
