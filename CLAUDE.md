# Solwyn TypeScript SDK (`@solwyn/sdk`)

Solwyn wraps an application's existing LLM client (OpenAI, Anthropic, Google, Bedrock, or an
OpenAI-compatible client), extracts usage, enforces budgets, handles failover, and reports
operational metadata to the Solwyn Cloud API.

Your LLM calls go directly to your provider. Solwyn receives usage and operational metadata,
plus tags you explicitly supply. Prompt and response content is not sent to Solwyn or logged by
the SDK. The drop-in client may inspect content inside the application process only to produce
length-based estimates or translate a request for cross-dialect failover. Tags are transmitted
verbatim and must contain only non-sensitive attribution data.

## Commands

```bash
pnpm check          # Biome lint/format check and tsc --noEmit
pnpm test           # offline Vitest unit suite with mocked fetch
pnpm build          # dual ESM/CJS bundles and declarations
pnpm test:dist      # exercise the built entry points
pnpm test:pack      # pack and test an installed provider-free consumer
pnpm test:consumers -- --tarball /absolute/path/sdk.tgz --out /absolute/outside-repo/path

pnpm surfaces:capture          # update reviewed provider-surface evidence
pnpm surfaces:check            # compare installed provider surfaces with the baseline
pnpm surfaces:diff <base-ref>  # show baseline changes relative to a Git ref
```

Build before running distribution or package checks. Unit tests must remain offline; mock
`fetch` and provider behavior rather than calling real providers.

## Public repository policy

- Keep contributor documentation self-contained. Do not add internal plans, review transcripts,
  personal filesystem paths, private issue links, credentials, customer data, or unreleased
  roadmap material.
- Prompt and response content, secrets, account identifiers, private URLs, and sensitive tag
  values do not belong in source, fixtures, issues, pull requests, logs, snapshots, or source
  maps. Use synthetic, sanitized examples.
- Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue or pull request.
- Run `node scripts/check-public-surface.mjs` before opening a pull request. This policy check
  complements, but does not replace, credential scanning and human review.

## Wire contract

- `tests/fixtures/openapi.snapshot.json` is the checked-in contract evidence. Approved contract
  refreshes replace the snapshot and its derived tables together.
- The SDK uses eight endpoint shapes: budget check/confirm, lease grant/renew/surrender,
  metadata ingest, untracked-surface reporting, and project provider-breaker reporting.
- Treat every wire-shape change as an API contract change. Strict response schemas must not use
  defaults or optional fields to hide drift. If runtime behavior and the approved wire contract
  conflict, stop and resolve the discrepancy explicitly.

## Non-negotiable invariants

1. **Privacy firewall.** Only `src/privacy.ts`, `src/providers/translation/`, and `src/ai-sdk/`
   may reference prompt or response content fields. `tests/unit/privacy-firewall.test.ts`
   enforces the boundary. Content must never be logged, persisted, or sent to Solwyn.
2. **Fixed estimate, never provider/model pricing.** Solwyn Cloud owns actual provider/model
   pricing. The SDK's `$0.00003 × estimated input tokens` calculation has exactly two local uses:
   outage decisions/bucketing, and the `estimatedCost` diagnostic on denial errors (including live
   Cloud denials). Do not use it for provider/model pricing or introduce another local formula.
3. **Outage authority is scoped.** Applicable retained project-period hard denials and exact-run
   denials/stops are evaluated before either outage posture. With `failOpen: true`, an otherwise
   eligible call proceeds and the estimate accrues in the current UTC-day local bucket. With
   `failOpen: false`, no prior successful budget snapshot denies; a known last budget limit can
   still allow when local accrued estimated spend plus the new estimate stays within that limit.
   A tag-period denial applies to its current selector and is not retained as future outage
   authority. A response with a run directive for another run is contract drift: enforce an
   ordinary verdict for that call, but do not retain the tainted response; a foreign
   `run_stopped` response enters the outage decision path.
4. **Zero provider-SDK imports in core.** Detection is duck-typed. Provider SDKs are optional
   peer dependencies, and the package must install, build, and run with none present. Type-only
   imports are acceptable only when completely erased.
5. **Registry order is load-bearing.** OpenAI-compatible adapters selected by base URL/host
   precede plain OpenAI; the generic compatible adapter is last among compatible adapters.
   Concrete adapters load lazily on first use.
6. **Provider name and dialect are different concepts.** `name` controls attribution, budgets,
   metadata, and breakers; `dialect` controls dispatch and translation. Same-dialect failover is
   native passthrough. Cross-dialect failover supports a minimal subset and fails loudly with
   `UntranslatableRequestError` or `UntranslatableModelError`. An explicit provider pin bypasses
   detection and synchronously rejects an incompatible client with
   `ConfigurationError(field: "client")`.
7. **No silent zero usage.** A compatible provider that reports no usable usage gets a
   length-based estimate marked `isEstimated: true`.
8. `checkBudget` requires `provider` as a named option.
9. Settlement confirmation is private and queued through the reporter; there is no public
   `confirmCost`. Consecutive confirmation failures escalate to ERROR at 10.
10. Runtime invariants throw typed `Error` subclasses (`SolwynError`, `BudgetExceededError`,
    `ProviderUnavailableError`, `ConfigurationError`, and the untranslatable errors). Do not use
    `console.assert` or TypeScript-only assertions for runtime safety.
11. Per-event ingest rejections are surfaced through the logger.
12. **Tags are explicit, non-sensitive attribution only.** Never infer tags from prompts or
    responses. Remove per-call `solwyn_tags` only on intercepted provider requests, and keep
    tagged calls lease-ineligible so tag-scoped policy remains authoritative.

## Architecture

- **One async `Solwyn` client.** Keep pure configuration, token extraction, estimation, and
  routing decisions separate from thin `fetch`-based transport.
- **Edge-safe core.** Core uses web-standard `fetch`, `AbortController`, `crypto.randomUUID`, and
  web streams. No `node:*` imports are allowed in core paths. AsyncLocalStorage run context lives
  behind the separate `./node` entry.
- Use zod 4 `z.strictObject({...})` for wire schemas. API response schemas declare every returned
  field as required.
- The ES `Proxy` around a wrapped client preserves `instanceof`, `.constructor`, stable method
  identity, own-key/descriptor reflection, and property mutation forwarding. Double wrapping
  throws `ConfigurationError(field: "client")` synchronously.
- Token estimation is heuristic and length-based; the SDK has no tokenizer dependency.
  Provider-reported usage is settlement truth whenever it is usable.
- Lifecycle supports explicit `close()` and `Symbol.asyncDispose`. Close in this order:
  settlement reporter, untracked advisory reporter, budget/lease holder, wrapped provider.
- Bedrock intercepts `client.send(command)` for `ConverseCommand` and
  `ConverseStreamCommand`, detected by command shape/name with no AWS imports. Raw
  `InvokeModel` calls fail loudly.
- Streaming settles from terminal usage events: OpenAI `include_usage` according to its compatible
  profile, Anthropic `message_delta`, and Bedrock `metadata`.
- Native OpenAI and Azure `responses.create`, `responses.parse`, and deferred `responses.stream`
  are metered and primary-only. Other compatible Responses managers remain unmetered.
- Run control is cooperative and exact-ID. A server directive or local velocity rule blocks
  future dispatch and aborts streams at the next provider-chunk boundary. `RunStoppedError` is a
  direct `SolwynError`; `clearRunTermination()` changes only future work.
- Untagged, run-scoped text calls use local token leases by default. Tagged, media, unscoped, and
  otherwise ineligible calls use per-call checks. Price hints are request-scoped, server-supplied,
  and never persisted on the client; lease results currently carry none.

## Configuration guardrails

- Constructor options are camelCase and map once to a strict internal configuration. Unknown
  keys and a present non-function `fetch` fail synchronously.
- `budgetMode` is not part of `BudgetCheckRequest`; a live response's `mode` is authoritative.
  The constructor option supplies the mode attached to SDK-local outage results, while `failOpen`
  controls the local allow/deny posture.
- Surface controls default to `onUnmetered: "warn"`, `acknowledgeUntracked: []`, and
  `reportUntrackedSurfaces: true`. Leases default to enabled with output bound `4096`.
- Failover defaults are a `30` second total window, `600` second per-hop request bound,
  idempotency `"safe"`, zero same-provider retries, and provider-breaker thresholds `3/60/2`
  with recovery jitter `0.2`. Timeout values reject booleans and non-finite numbers; the hop
  bound is positive while a zero total window is valid.
- Reporter defaults are batch `50`, flush `5` seconds, queue `10_000`, max in-flight `3`, send
  attempts `5`, retry backoff `1..60` seconds, shutdown deadline `5` seconds, and breaker
  heartbeat `60` seconds.
- Velocity defaults are mode `"warn"`, repeat `5` within `60` seconds, growth streak/factor
  `8/3`, and acceleration floor/factor `30/3`. Only repeat and monotonic growth are deny-eligible;
  rate acceleration is advisory.

## Source layout

```text
src/
  index.ts              # public exports; edge-safe core only
  node.ts               # Node-only run context
  ai-sdk/               # AI SDK middleware; content-privileged
  testing/              # edge-safe fake control plane and contract probes
  config.ts  types.ts  errors.ts  validation.ts
  privacy.ts            # content-privileged estimation helpers
  token-details.ts  tags.ts  read-only-key.ts
  budget.ts  lease.ts  circuit-breaker.ts  reporter.ts  receipt-fold.ts
  run-control.ts  velocity.ts
  routing.ts  registry.ts  client.ts  stream.ts  transport.ts
  coverage.ts  surfaces.ts  surface-rules.ts  surface-graph.ts  surface-guard.ts
  providers/
    protocol.ts  accumulator.ts  errors.ts
    openai.ts  openai-compatible.ts  anthropic.ts  google.ts  bedrock.ts
    translation/        # content-privileged
tests/unit/             # offline tests with mocked transport/provider behavior
```

## Development conventions

- Read the relevant source, public documentation, contract fixture, and tests before changing a
  subsystem. Preserve tested behavior unless the change explicitly revises the public contract.
- Add or update focused offline tests for behavior changes. Never call real providers from the
  unit suite.
- Biome enforces formatting and forbids `console.*` in `src`; use the logger abstraction.
- Update provider baselines and fingerprints only through `pnpm surfaces:capture` after reviewing
  drift. Curated rules in `src/surface-rules.ts` remain hand-authored; closed-world payloads are
  test evidence and never ship in the package.
- Document user-visible and breaking changes in `CHANGELOG.md` and release notes before users
  upgrade. This project is a public preview, so compatibility decisions must be explicit.
