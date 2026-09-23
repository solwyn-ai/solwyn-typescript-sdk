// Forced-GC probe: clients dropped without close() must release their provider, lease
// holder and reporter, stop their timers and heartbeats, and leave the Node exit registry,
// while queued work is still delivered first and reachable clients keep their cadence.
// Offline only: in-process fake provider and fake control plane. Prints one JSON object.
import assert from "node:assert/strict";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { createSolwynMiddleware } from "../../src/ai-sdk/index";
import { noopLogger, run, Solwyn } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import type { FetchLike } from "../../src/transport";

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const PROJECT = `proj_${"0".repeat(24)}`;
const REPORTER_HOOK = Symbol.for("@solwyn/sdk/node-reporter-registration");
const LEASE_HOOK = Symbol.for("@solwyn/sdk/node-lease-registration");
const REGISTRY = Symbol.for("@solwyn/sdk/node-reporter-registry");
const RUN_OWNERS = Symbol.for("@solwyn/sdk.node.runOwners");
const RUN_READER = Symbol.for("@solwyn/sdk.currentRunReader");

type Registry = { reporters: Set<WeakRef<object>>; leaseHolders: Set<WeakRef<object>> };
const registry = (): Registry => Reflect.get(globalThis, REGISTRY) as Registry;

// Capture weak references to every internal reporter and lease holder the SDK registers.
const reporterRefs: WeakRef<object>[] = [];
const leaseRefs: WeakRef<object>[] = [];
for (const [hook, refs] of [
  [REPORTER_HOOK, reporterRefs],
  [LEASE_HOOK, leaseRefs],
] as const) {
  const register = Reflect.get(globalThis, hook) as (participant: object) => void;
  assert.equal(typeof register, "function", "the Node entry installs registration hooks");
  Reflect.set(globalThis, hook, (participant: object) => {
    refs.push(new WeakRef(participant));
    register(participant);
  });
}

// Count ordinary delivery rounds per reporter, without retaining any reporter.
const heldReporters = new WeakSet<object>();
const rounds = { held: 0, dropped: 0 };
const flushRemaining = MetadataReporter.prototype._flushRemaining;
MetadataReporter.prototype._flushRemaining = function (this: MetadataReporter, ...args) {
  if (args[1] !== true) {
    if (heldReporters.has(this)) rounds.held += 1;
    else rounds.dropped += 1;
  }
  return flushRemaining.apply(this, args);
};

const alive = (refs: readonly WeakRef<object>[]): number =>
  refs.filter((ref) => ref.deref() !== undefined).length;

async function collect(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await setImmediate();
    await sleep(2);
    forceGc?.();
  }
  await setImmediate();
}

async function collectUntil(refs: readonly WeakRef<object>[], maxRounds = 40): Promise<void> {
  for (let round = 0; round < maxRounds && alive(refs) > 0; round++) await collect();
}

interface Counters {
  checks: number;
  confirms: number;
  reservations: number;
  confirmFailures: number;
  ingests: number;
  breaker: number;
  grants: number;
  surrenders: number;
  surrenderFailures: number;
  spentReported: number;
  confirmed: Map<string, number>;
  ingested: Map<string, number>;
}

function counters(): Counters {
  return {
    checks: 0,
    confirms: 0,
    reservations: 0,
    confirmFailures: 0,
    ingests: 0,
    breaker: 0,
    grants: 0,
    surrenders: 0,
    surrenderFailures: 0,
    spentReported: 0,
    confirmed: new Map(),
    ingested: new Map(),
  };
}

const requests = (count: Counters): number =>
  count.checks + count.confirms + count.ingests + count.breaker + count.grants + count.surrenders;

interface PlaneOptions {
  readonly reservations?: boolean;
  readonly failFirstConfirm?: boolean;
  readonly failFirstIngest?: boolean;
  readonly failSurrenders?: boolean;
}

let reservation = 0;
function controlPlane(count: Counters, options: PlaneOptions = {}): FetchLike {
  let ingestFailed = false;
  const confirmFailed = new Set<string>();
  return async (url, init) => {
    if (url.endsWith("/budgets/check")) {
      count.checks++;
      if (options.reservations) count.reservations++;
      return Response.json({
        allowed: true,
        remaining_budget: 100,
        reservation_id: options.reservations ? `res-${++reservation}` : null,
        mode: "alert_only",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: null,
        project_id: PROJECT,
        price_hints: null,
      });
    }
    if (url.endsWith("/budgets/confirm")) {
      count.confirms++;
      const body = JSON.parse(String(init?.body)) as { reservation_id: string };
      if (options.failFirstConfirm && !confirmFailed.has(body.reservation_id)) {
        confirmFailed.add(body.reservation_id);
        count.confirmFailures++;
        return new Response(null, { status: 503 });
      }
      await sleep(5); // a delayed, then successful, send
      count.confirmed.set(body.reservation_id, (count.confirmed.get(body.reservation_id) ?? 0) + 1);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/metadata/ingest")) {
      count.ingests++;
      const body = JSON.parse(String(init?.body)) as Array<{ call_id: string }>;
      if (options.failFirstIngest && !ingestFailed) {
        ingestFailed = true;
        return new Response(null, { status: 503 });
      }
      for (const item of body) {
        count.ingested.set(item.call_id, (count.ingested.get(item.call_id) ?? 0) + 1);
      }
      return Response.json({ ingested: body.length, rejected: [] }, { status: 202 });
    }
    if (url.includes("/providers/breaker-reports")) {
      count.breaker++;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/budgets/lease/surrender")) {
      count.surrenders++;
      if (options.failSurrenders) {
        count.surrenderFailures++;
        return new Response(null, { status: 503 });
      }
      const body = JSON.parse(String(init?.body)) as { spent_tokens?: number };
      count.spentReported += body.spent_tokens ?? 0;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/budgets/lease")) {
      count.grants++;
      return Response.json({
        eligible: true,
        allowed: true,
        lease_id: `lease-${count.grants}`,
        generation: 1,
        granted_tokens: 10_000,
        refresh_interval_s: 1000,
        lease_length_s: 2000,
        headroom_share_tokens: 100,
        posture: { mode: "alert_only", on_unreachable: "fail_open" },
        final_grant: true,
        project_id: PROJECT,
        mode: "alert_only",
        budget_limit: 100,
        current_usage: 0,
        remaining_budget: 100,
      });
    }
    throw new Error("unexpected control-plane path");
  };
}

type Provider = {
  readonly marker: Uint8Array;
  chat: { completions: { create: (...args: unknown[]) => Promise<unknown> } };
};
function provider(): Provider {
  return {
    marker: new Uint8Array(64 * 1024),
    chat: {
      completions: {
        create: async () => ({ usage: { prompt_tokens: 2, completion_tokens: 0 } }),
      },
    },
  };
}

interface ClientOptions {
  readonly flush?: number;
  readonly heartbeat?: number;
  readonly lease?: boolean;
  readonly breakers?: boolean;
}
function middlewareOptions(fetch: FetchLike, extra: ClientOptions = {}) {
  return {
    apiKey: API_KEY,
    apiUrl: "https://retention.invalid",
    logger: noopLogger,
    leaseEnabled: extra.lease ?? false,
    breakerReportingEnabled: extra.breakers ?? false,
    reporterFlushInterval: extra.flush ?? 0.02,
    breakerReportHeartbeat: extra.heartbeat ?? 0.05,
    reporterRetryBackoffBase: 0.01,
    reporterRetryBackoffCap: 0.02,
    fetch,
  };
}
function options(fetch: FetchLike, extra: ClientOptions = {}) {
  return {
    ...middlewareOptions(fetch, extra),
    reportUntrackedSurfaces: false,
    velocityMode: "off" as const,
  };
}

const call = { model: "gpt-4o", max_tokens: 1 } as never;

/** Build, optionally call and drop one client; returns only a weak provider reference. */
async function dropClient(
  fetch: FetchLike,
  mode: "idle" | "after-call" | "leased-run",
  extra: ClientOptions = {},
  calls = 1,
): Promise<WeakRef<object>> {
  const raw = provider();
  const client = new Solwyn(raw, options(fetch, extra));
  if (mode === "after-call") {
    for (let index = 0; index < calls; index++) await client.chat.completions.create(call);
  }
  if (mode === "leased-run") {
    await run("leased", async () => {
      for (let index = 0; index < calls; index++) await client.chat.completions.create(call);
    });
  }
  return new WeakRef(raw);
}

async function stageA() {
  const lanes: Record<string, unknown> = {};
  for (const mode of ["idle", "after-call", "leased-run"] as const) {
    const count = counters();
    const fetch = controlPlane(count, { failSurrenders: mode === "leased-run" });
    const firstLease = leaseRefs.length;
    const providers: WeakRef<object>[] = [];
    for (let index = 0; index < 20; index++) {
      providers.push(await dropClient(fetch, mode, { lease: mode === "leased-run" }, 2));
    }
    const holders = leaseRefs.slice(firstLease);
    await collectUntil([...providers, ...holders]);
    lanes[mode] = {
      clients: providers.length,
      providersAlive: alive(providers),
      leaseHoldersAlive: alive(holders),
      leaseGrants: count.grants,
    };
  }
  return { lanes };
}

async function heartbeat() {
  const heldCount = counters();
  const droppedCount = counters();
  const heldRaw = provider();
  const held = new Solwyn(heldRaw, options(controlPlane(heldCount), { breakers: true }));
  const heldReporter = reporterRefs.at(-1)?.deref();
  assert.ok(heldReporter);
  heldReporters.add(heldReporter);
  await held.chat.completions.create(call);

  const firstReporter = reporterRefs.length;
  const providers: WeakRef<object>[] = [];
  for (let index = 0; index < 10; index++) {
    providers.push(await dropClient(controlPlane(droppedCount), "after-call", { breakers: true }));
  }
  const reporters = reporterRefs.slice(firstReporter);
  // Let dropped clients deliver their settlement and start heartbeating before the drop.
  await sleep(150);
  const droppedBreakerBeforeDrop = droppedCount.breaker;
  await collectUntil([...providers, ...reporters]);

  const before = {
    dropped: requests(droppedCount),
    breaker: droppedCount.breaker,
    heldBreaker: heldCount.breaker,
    rounds: rounds.dropped,
    heldRounds: rounds.held,
  };
  // An accelerated window of twenty heartbeat periods (default cadence is 60 s).
  for (let index = 0; index < 20; index++) {
    await sleep(50);
    forceGc?.();
  }
  const result = {
    droppedClients: providers.length,
    droppedBreakerBeforeDrop,
    droppedProvidersAlive: alive(providers),
    droppedReportersAlive: alive(reporters),
    droppedBreakerPostsInWindow: droppedCount.breaker - before.breaker,
    droppedRequestsInWindow: requests(droppedCount) - before.dropped,
    droppedRoundsInWindow: rounds.dropped - before.rounds,
    heldBreakerPostsInWindow: heldCount.breaker - before.heldBreaker,
    heldRoundsInWindow: rounds.held - before.heldRounds,
    heldProviderAlive: heldRaw.marker.length > 0,
  };
  await held.close();
  return result;
}

async function retryDelivery() {
  const count = counters();
  const fetch = controlPlane(count, {
    reservations: true,
    failFirstConfirm: true,
    failFirstIngest: true,
  });
  const firstReporter = reporterRefs.length;
  const providers: WeakRef<object>[] = [];
  for (let index = 0; index < 3; index++) {
    providers.push(await dropClient(fetch, "after-call", {}, 2));
  }
  const reporters = reporterRefs.slice(firstReporter);
  // Collect aggressively while the dropped clients' first sends fail and retry.
  const pending = (): boolean =>
    count.confirmed.size < count.reservations || count.ingested.size < 6;
  for (let round = 0; round < 200 && pending(); round++) {
    await collect(1);
  }
  const reportersAliveAfterDelivery = alive(reporters);
  await collectUntil([...providers, ...reporters]);
  const before = requests(count);
  for (let index = 0; index < 10; index++) {
    await sleep(20);
    forceGc?.();
  }
  return {
    calls: 6,
    reservations: count.reservations,
    confirmFailures: count.confirmFailures,
    confirmedOnce: [...count.confirmed.values()].filter((n) => n === 1).length,
    confirmedMoreThanOnce: [...count.confirmed.values()].filter((n) => n > 1).length,
    ingestedOnce: [...count.ingested.values()].filter((n) => n === 1).length,
    ingestedMoreThanOnce: [...count.ingested.values()].filter((n) => n > 1).length,
    reportersAliveAfterDelivery,
    providersAlive: alive(providers),
    reportersAlive: alive(reporters),
    requestsAfterCollection: requests(count) - before,
  };
}

async function registryScenario() {
  let derefs = 0;
  const deref = WeakRef.prototype.deref;
  const count = counters();
  const fetch = controlPlane(count);
  const held: object[] = [];
  const heldStart = reporterRefs.length;
  WeakRef.prototype.deref = function (this: WeakRef<object>) {
    derefs += 1;
    return deref.call(this);
  };
  try {
    for (let index = 0; index < 200; index++) {
      held.push(new Solwyn(provider(), options(fetch, { lease: true })));
    }
  } finally {
    WeakRef.prototype.deref = deref;
  }
  const liveRegistrations = 200;
  const sizesWhileHeld = {
    reporters: registry().reporters.size,
    leaseHolders: registry().leaseHolders.size,
  };

  const firstReporter = reporterRefs.length;
  const firstLease = leaseRefs.length;
  for (let index = 0; index < 200; index++) await dropClient(fetch, "idle", { lease: true });
  const dropped = [...reporterRefs.slice(firstReporter), ...leaseRefs.slice(firstLease)];
  await collectUntil(dropped);
  const sizesAfterDrop = {
    reporters: registry().reporters.size,
    leaseHolders: registry().leaseHolders.size,
  };

  const heldRefs = reporterRefs.slice(heldStart, firstReporter);
  held.length = 0;
  await collectUntil(heldRefs);
  return {
    liveRegistrations,
    registrationDerefs: derefs,
    sizesWhileHeld,
    droppedParticipantsAlive: alive(dropped),
    sizesAfterDrop,
    sizesAfterAllDropped: {
      reporters: registry().reporters.size,
      leaseHolders: registry().leaseHolders.size,
    },
  };
}

async function runRetire() {
  const owners = Reflect.get(globalThis, RUN_OWNERS) as { resources: Map<number, object> };
  const reader = Reflect.get(globalThis, RUN_READER) as () => { lifetime?: object } | undefined;
  const count = counters();
  const raw = provider();
  let client: (Provider & { close(): Promise<void> }) | undefined;
  let firstRun: WeakRef<object> | undefined;
  await run("first-request", async () => {
    // A lazily constructed singleton: built by the first request, reused afterwards.
    client ??= new Solwyn(raw, options(controlPlane(count), { lease: true, flush: 0.01 }));
    const lifetime = reader()?.lifetime;
    assert.ok(lifetime);
    firstRun = new WeakRef(lifetime);
    await client.chat.completions.create(call);
  });
  for (let index = 0; index < 5; index++) {
    await run("later-request", () => client?.chat.completions.create(call));
  }
  await sleep(100); // several flush-loop turns
  const pinned = (): number => {
    const lifetime = firstRun?.deref();
    let n = 0;
    if (lifetime === undefined) return 0;
    for (const owner of owners.resources.values()) if (owner === lifetime) n++;
    return n;
  };
  await collect();
  const pinnedOwnerEntries = pinned();
  for (let round = 0; round < 20 && count.surrenders < count.grants; round++) await collect();
  const result = {
    pinnedOwnerEntries,
    firstRunRetired: firstRun?.deref() === undefined,
    leaseGrants: count.grants,
    surrendersBeforeClose: count.surrenders,
    spentTokensReportedBeforeClose: count.spentReported,
    expectedSpentTokens: 12,
  };
  await client?.close();
  return result;
}

async function middleware() {
  const heldCount = counters();
  const droppedCount = counters();
  const held = createSolwynMiddleware(middlewareOptions(controlPlane(heldCount), { lease: true }));
  const heldReporter = reporterRefs.at(-1)?.deref();
  assert.ok(heldReporter);
  heldReporters.add(heldReporter);

  const firstReporter = reporterRefs.length;
  const firstLease = leaseRefs.length;
  const dropOne = async (withCall: boolean): Promise<void> => {
    const handle = createSolwynMiddleware(
      middlewareOptions(controlPlane(droppedCount), { lease: true }),
    );
    if (!withCall) return;
    const wrapGenerate = handle.middleware.wrapGenerate as unknown as (
      args: unknown,
    ) => Promise<unknown>;
    await wrapGenerate({
      model: { provider: "openai.chat", modelId: "gpt-4o" },
      params: { prompt: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }] },
      doGenerate: async () => ({
        content: [{ type: "text", text: "synthetic" }],
        usage: {
          inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }),
    });
  };
  for (let index = 0; index < 10; index++) await dropOne(index % 2 === 1);
  const reporters = reporterRefs.slice(firstReporter);
  const holders = leaseRefs.slice(firstLease);
  await sleep(100); // deliver the dropped handles' queued events first
  const ingestedBeforeDrop = droppedCount.ingests;
  await collectUntil([...reporters, ...holders]);
  const before = { requests: requests(droppedCount), rounds: rounds.dropped, held: rounds.held };
  for (let index = 0; index < 10; index++) {
    await sleep(20);
    forceGc?.();
  }
  const result = {
    droppedHandles: 10,
    ingestedBeforeDrop,
    droppedReportersAlive: alive(reporters),
    droppedLeaseHoldersAlive: alive(holders),
    droppedRequestsInWindow: requests(droppedCount) - before.requests,
    droppedRoundsInWindow: rounds.dropped - before.rounds,
    heldRoundsInWindow: rounds.held - before.held,
    registrySizes: {
      reporters: registry().reporters.size,
      leaseHolders: registry().leaseHolders.size,
    },
  };
  await held.close();
  return result;
}

const scenarios: Record<string, () => Promise<unknown>> = {
  "stage-a": stageA,
  heartbeat,
  "retry-delivery": retryDelivery,
  registry: registryScenario,
  "run-retire": runRetire,
  middleware,
};
const name = process.argv[2] ?? "";
const scenario = scenarios[name];
assert.ok(scenario, "unknown scenario");
const result = await scenario();
process.stdout.write(`${JSON.stringify({ scenario: name, ...(result as object) })}\n`);
process.exit(0);
