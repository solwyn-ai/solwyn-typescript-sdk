# Changelog

All notable changes to `@solwyn/sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`0.x` releases are a public preview. Breaking changes are called out in this changelog and the
corresponding release notes before users upgrade.

## [Unreleased]

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
