# Testing budget enforcement

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#testing-budget-enforcement).

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
      plane.stopRun(runId, { reason: "manual_kill" });
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
| `solwyn-test/deny` | Monthly denial under `hard_deny`; allowed overrun under `alert_only` | Same project-mode behavior | no |
| `solwyn-test/deny-alert` | Allowed overrun forced to `alert_only`, with a reservation and negative remaining budget | Allowed lease with alert-only posture and negative remaining budget | no |
| `solwyn-test/deny-tag` | Tag denial in `hard_deny` mode | `eligible=false`, `allowed=true`, `ineligible_reason="scoped_rules_present"` | no |
| `solwyn-test/deny-stopped` | `run_stopped`, `hard_deny`, remaining budget 0; opted-in `manual_kill` directive | Same stopped-run verdict; no lease block | yes |
| `solwyn-test/runaway` | First sighting per run is allowed; later sightings deny `agent_run` in `hard_deny` mode | Same | yes |
| `solwyn-test/kill` | First sighting per run is allowed; later sightings stop the run with `run_stopped` | Same, including the run-control directive when opted in | yes |
| `solwyn-test/lease-ineligible` | Transparent and allowed | `eligible=false`, `allowed=true`, `ineligible_reason="zero_rate_model"`; no lease block | no |

`FakeControlPlane` leases default to a 120-second lifetime and a 15-second refresh. Use
`postureMode: "hard_deny"` to model scoped or run enforcement on an alert-only project; only a
hard posture can produce `final_grant`. `runUsage: { "synthetic-run": 7.5 }` supplies explicit
synthetic spend for stopped-run checks, independently of project `currentUsage`. Stop reasons
are limited to `"manual_kill"`. Legacy checks omit directive keys, and opted-in text checks return
a price-hint map (by default `{ [provider]: 1 }`; non-text or unpriceable checks return `{}`).
Set `priceHints: null` to return an empty map on opted-in text checks; this does not omit the
`price_hints` field.

### API keys and projects

The fake authenticates every control-plane request the way Solwyn does. It requires
`Authorization: Bearer <plane.apiKey>` and a `Solwyn-Project` header naming `plane.project` (the
project name, `test-project` by default) or its `proj_` id (`projectId`, default
`proj_000000000000000000000000`). A missing header returns `400 project_selector_required`; a
header that matches neither returns `404 project_not_found`. `GET /api/v1/auth/key` returns the
key and the resolved project, and every authenticated response carries `Solwyn-Project-Id`.
`plane.wrap(...)` configures `project` for you; `project` is a reserved wrap option.

| Method or option | Effect |
|------------------|--------|
| `keyScope: "read_only"` | `/auth/key` reports a read-only key, so `validate()` and the first call refuse |
| `expireKey({ projectBudgetMode?, requests?, path? })` | `401 api_key_expired`; the posture defaults to `hard_deny` when `mode` or `postureMode` is `hard_deny`, else `alert_only` (`null` sends a null posture) |
| `revokeKey({ projectBudgetMode?, requests?, path? })` | `401 api_key_invalid` with the same posture rule |
| `refuseKey({ status, body }, { requests?, path? })` | Any exact refusal response, for malformed 401 bodies and similar cases |
| `refuseProject("project_not_found" \| "key_not_dedicated", { requests?, path? })` | A project refusal after the key is accepted |
| `renameProject(name)` | The old name stops matching; the `proj_` id keeps working |
| `readOnly()` | Writes return `403 read_only_key`, and `/auth/key` reports a read-only key |

`plane.authKeyRequests` and `plane.projectHeaders` record the `Solwyn-Project` value of each
`/auth/key` request and of every request. `plane.handle(...)` dispatches as an already
authenticated request. `assertAuthKeyContract(fetch, { apiUrl, apiKey, project })` checks the
`/auth/key` shape, the id echo, pinning by name and by id, and the `project_selector_required`,
`project_not_found` and `api_key_invalid` refusals against the fake or a live plane; every other
contract probe now also takes `project`.

The fake stores only accepted ingest events and returns indexed `rejected` and `duplicates`
arrays. It enforces the server's 1,000-event metadata batch limit, 100-report untracked batch
limit, 256 KiB untracked body limit, unique untracked keys within a batch, and project matching
for breaker reports. Contract probes preserve any gateway prefix in `apiUrl`.

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
