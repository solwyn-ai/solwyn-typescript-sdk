# Configuration reference

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#configuration).

## Constructor options and environment variables

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
| `traceCorrelation` | `SOLWYN_TRACE_CORRELATION` | `true` | Include the active OpenTelemetry trace ID, span ID, and sampled flag in metadata events when your application has an active span; set `false` to disable capture. Also accepted by `createSolwynMiddleware` |
| `leaseEnabled` | `SOLWYN_LEASE_ENABLED` | `true` | Enable local run-scoped token leases |
| `leaseOutputBoundDefault` | `SOLWYN_LEASE_OUTPUT_BOUND_DEFAULT` | `4096` | Output-token reservation when a request has no usable cap |
| `selectionPolicy` | — | `HealthBasedPolicy` | Injectable candidate-ordering policy with an `order()` method |
| `failoverIdempotency` | — | `"safe"` | Cross-provider failover idempotency policy |
| `sameProviderRetries` | — | `0` | Same-provider `Retry-After` retries |
| `failoverTotalTimeout` | — | `30` | Failover-window seconds; does not cap an in-flight provider read |
| `failoverHopReadTimeout` | — | `600` | Per-attempt timeout in seconds; covered phases vary by provider (see below) |
| `circuitBreakerRecoveryTimeoutJitter` | — | `0.2` | Provider-breaker recovery jitter fraction (0–1) |
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
| `reporterBatchSize` | `SOLWYN_REPORTER_BATCH_SIZE` | `50` | Events per ingest batch (1–1000) |
| `reporterFlushInterval` | `SOLWYN_REPORTER_FLUSH_INTERVAL` | `5` | Background flush interval in seconds |
| `reporterMaxQueueSize` | `SOLWYN_REPORTER_MAX_QUEUE_SIZE` | `10000` | Reporter queue cap; overflow drops oldest |
| `reporterMaxInFlight` | `SOLWYN_REPORTER_MAX_IN_FLIGHT` | `3` | Maximum concurrent confirmation POSTs; ingest batches remain serial |
| `reporterMaxSendAttempts` | `SOLWYN_REPORTER_MAX_SEND_ATTEMPTS` | `5` | Ordinary retryable send attempts; HTTP 429 has a separate 20-response cap |
| `reporterRetryBackoffBase` | `SOLWYN_REPORTER_RETRY_BACKOFF_BASE` | `1` | Exponential retry base in seconds, with half-to-full jitter |
| `reporterRetryBackoffCap` | `SOLWYN_REPORTER_RETRY_BACKOFF_CAP` | `60` | Retry backoff cap in seconds |
| `reporterShutdownDeadline` | `SOLWYN_REPORTER_SHUTDOWN_DEADLINE` | `5` | Shared deadline for in-flight calls, settlement, and advisory delivery in seconds; `0` is valid |
| `breakerReportHeartbeat` | `SOLWYN_BREAKER_REPORT_HEARTBEAT` | `60` | Full breaker-report refresh interval in seconds (greater than 0, at most 60) |
| `velocityMode` | `SOLWYN_VELOCITY_MODE` | `"warn"` | Local velocity posture: `"off"`, `"warn"`, or `"deny"` |
| `velocityRepeatCount` | `SOLWYN_VELOCITY_REPEAT_COUNT` | `5` | Near-identical same-model calls required (2–64) |
| `velocityRepeatWindowS` | `SOLWYN_VELOCITY_REPEAT_WINDOW_S` | `60` | Repeat detection window in seconds |
| `velocityGrowthStreak` | `SOLWYN_VELOCITY_GROWTH_STREAK` | `8` | Successive calls whose estimated input sizes must strictly increase (3–64) |
| `velocityGrowthFactor` | `SOLWYN_VELOCITY_GROWTH_FACTOR` | `3` | Latest/first estimated-input ratio |
| `velocityAccelFloorPerMin` | `SOLWYN_VELOCITY_ACCEL_FLOOR_PER_MIN` | `30` | Minimum current-minute call count (1–64) |
| `velocityAccelFactor` | `SOLWYN_VELOCITY_ACCEL_FACTOR` | `3` | Current/prior-minute call-count ratio |

Env fallback is a **presence check**: an env var is consulted only when the corresponding option is `undefined`. An explicitly-passed `false`, `0`, or `""` always wins over the env var. Client objects, request defaults, routing policies, injected transports, and failover-only knobs remain code-only. Unknown option keys and a present non-function `fetch` fail synchronously with `ConfigurationError`.

An injected `logger` must provide all four `debug`, `info`, `warn`, and `error` methods;
`selectionPolicy` must provide `order()`. Partial objects are rejected synchronously.
Constructor and environment configuration schema errors identify the internal snake_case
`ConfigurationError.field`, for example `budget_check_timeout` or `failover_hop_read_timeout`.

Numeric settings reject booleans and empty strings. Breaker thresholds and reporter counts must
be positive integers; `sameProviderRetries` permits zero. Timeout, cache, recovery, flush,
backoff, and shutdown durations must be finite and no greater than `2147483.647` seconds, so
their millisecond delays fit the runtime timer range. Cache TTLs and provider-breaker recovery
waits remain integer seconds. `budgetCheckTimeout` must be at least `0.1` seconds;
`failoverHopReadTimeout`, flush/backoff intervals, and heartbeats must be positive; cache TTLs,
recovery waits, and shutdown deadlines permit zero. Direct `BudgetEnforcer` options apply the
same duration limit to `cacheTtl` and per-call `timeout`, with zero allowed only for `cacheTtl`
and a minimum of `0.1` seconds for `timeout`.

Velocity repeat windows must be positive, and growth and acceleration factors must exceed
one. These three velocity options also accept positive infinity to disable the corresponding
bound. The acceleration floor must be an integer from 1 through 64.

`failoverTotalTimeout` must be non-negative. A zero value prevents new work from starting after
call entry. JavaScript provider SDKs expose a single per-request
timeout carrier rather than separate connect and read phases, and what it covers differs by SDK.
For the OpenAI, OpenAI-compatible, and Anthropic SDKs, `failoverHopReadTimeout` covers only
connecting and receiving response headers: a response body or stream that stalls after its first
bytes is not interrupted. For Google, Solwyn keeps the bound armed until the buffered response or
the stream finishes, so it also limits the total duration of a healthy stream. To bound a stalled
stream on the other SDKs, pass an `AbortSignal` in the request options or apply your own idle
timeout while iterating. Bedrock's `requestTimeout` is not a universal hard abort for every
Converse stream handler; configure a finite socket timeout on the AWS request handler too.
