# Run control and velocity limits

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#run-control-and-velocity-limits).

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
The detector retains up to 64 observations per run for at most 4096 runs. Stale run histories
are discarded first; at the hard cap, a random live history is displaced to avoid systematically
resetting loops under run churn or round-robin traffic. `velocity.history_evicted` warns at most
once every 30 seconds. A displaced run can lose observations needed to detect a loop.

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

## Detached run handles

Importing the Node entry leaves its extra lifetime-tracking async hook disabled. The hook
is enabled while callback runs, unfinished detached handles, or their async work retain a
run lifetime, and adds process-wide promise overhead during that time. It is disabled once
the last lifetime is garbage-collected; ending a callback or finishing a handle can
therefore precede hook shutdown. Finish detached handles when their work is complete.

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
