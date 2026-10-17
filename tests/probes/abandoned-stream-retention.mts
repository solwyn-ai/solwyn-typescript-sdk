import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { noopLogger, run, Solwyn } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import { getCurrentRun } from "../../src/run-context";
import type { FetchLike } from "../../src/transport";

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");
const lifetimes: WeakRef<object>[] = [];
const signals: WeakRef<object>[] = [];
const wrappers: WeakRef<object>[] = [];
const settlements: { input: number; output: number }[] = [];
const surrenders: Record<string, unknown>[] = [];
const reportSettlement = MetadataReporter.prototype.reportSettlement;
MetadataReporter.prototype.reportSettlement = function (request, event) {
  settlements.push({ input: event.input_tokens, output: event.output_tokens });
  reportSettlement.call(this, request, event);
};
let grants = 0;
const fetch: FetchLike = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? "null"));
  if (url.endsWith("/budgets/lease"))
    return Response.json({
      eligible: true,
      allowed: true,
      lease_id: `lease-${++grants}`,
      generation: 1,
      granted_tokens: 2000,
      refresh_interval_s: 300,
      lease_length_s: 600,
      headroom_share_tokens: 0,
      posture: { mode: "hard_deny", on_unreachable: "local_enforce" },
      final_grant: true,
      project_id: `proj_${"0".repeat(24)}`,
      mode: "hard_deny",
      budget_limit: 100,
      current_usage: 0,
      remaining_budget: 100,
    });
  if (url.endsWith("/budgets/check"))
    return Response.json({
      allowed: true,
      remaining_budget: 100,
      reservation_id: "reservation-abandoned",
      mode: "hard_deny",
      budget_limit: 100,
      current_usage: 0,
      denied_by_period: null,
      project_id: `proj_${"0".repeat(24)}`,
      price_hints: null,
    });
  if (url.endsWith("/metadata/ingest"))
    return Response.json({ ingested: body.length, rejected: [], duplicates: [] }, { status: 202 });
  if (url.endsWith("/budgets/lease/surrender")) surrenders.push(body);
  return new Response(null, { status: 204 });
};
const options = {
  apiKey: `sk_proj_${"0".repeat(64)}`,
  fetch,
  logger: noopLogger,
  velocityMode: "off" as const,
  reportUntrackedSurfaces: false,
  breakerReportingEnabled: false,
  budgetCheckCacheTtl: 0,
};
const sdk = new Solwyn(
  {
    chat: {
      completions: {
        create: async (_params: Record<string, unknown>, _options?: unknown) =>
          (async function* () {
            yield { usage: { prompt_tokens: 17, completion_tokens: 6 } };
            yield {};
          })(),
      },
    },
  },
  options,
);
async function abandon(): Promise<void> {
  await run("abandoned-stream", async () => {
    const lifetime = getCurrentRun()?.lifetime;
    assert.ok(lifetime);
    lifetimes.push(new WeakRef(lifetime));
    const caller = new AbortController();
    signals.push(new WeakRef(caller.signal));
    const stream = await sdk.chat.completions.create(
      { model: "gpt-4o", stream: true, max_tokens: 30 },
      { signal: caller.signal },
    );
    wrappers.push(new WeakRef(stream));
    await stream.next();
  });
}
async function collect(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) {
    await setImmediate();
    forceGc?.();
  }
}
try {
  for (let index = 0; index < 10; index++) await abandon();
  await collect();
  const alive = (refs: WeakRef<object>[]) => refs.filter((ref) => ref.deref()).length;
  assert.equal(alive(wrappers), 0, "abandoned wrappers must be collectible");
  assert.equal(alive(lifetimes), 0, "abandoned streams must release run lifetimes");
  assert.equal(alive(signals), 0, "abandoned streams must release caller signals");
  assert.equal(settlements.length, 10, "finalization settles each stream before client close");
  assert.ok(settlements.every((usage) => usage.input === 17 && usage.output === 6));
  assert.equal(surrenders.length, 10, "run leases retire before client close");
  assert.ok(surrenders.every((request) => request["spent_tokens"] === 23));
  await sdk.close();
  assert.equal(settlements.length, 10, "close must not settle collected streams again");

  // Recovery eligibility uses a clock jump; the real probe timer never expires here.
  const realNow = performance.now.bind(performance);
  let offset = 0;
  performance.now = () => realNow() + offset;
  let calls = 0;
  const probeClient = new Solwyn(
    {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            if (++calls === 1) throw Object.assign(new Error("busy"), { status: 429 });
            if (params["stream"])
              return (async function* () {
                yield {};
              })();
            return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
          },
        },
      },
    },
    {
      ...options,
      leaseEnabled: false,
      circuitBreakerFailureThreshold: 1,
      circuitBreakerRecoveryTimeout: 60,
      circuitBreakerRecoveryTimeoutJitter: 0,
    },
  );
  try {
    await assert.rejects(probeClient.chat.completions.create({ model: "gpt-4o" }));
    offset = 61_000;
    async function abandonProbe(): Promise<void> {
      await probeClient.chat.completions.create({ model: "gpt-4o", stream: true });
    }
    await abandonProbe();
    await assert.rejects(probeClient.chat.completions.create({ model: "gpt-4o" }));
    await collect();
    await probeClient.chat.completions.create({ model: "gpt-4o" });
    assert.equal(calls, 3, "finalization releases the probe without waiting for expiry");
  } finally {
    await probeClient.close();
    performance.now = realNow;
  }
  process.stdout.write(JSON.stringify({ ok: true, abandoned: 10, probe_released: true }));
} finally {
  await sdk.close();
  MetadataReporter.prototype.reportSettlement = reportSettlement;
}
