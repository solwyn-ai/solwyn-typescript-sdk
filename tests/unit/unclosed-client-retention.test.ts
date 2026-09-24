import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import { getCurrentRun } from "../../src/run-context";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;

// Each scenario runs in its own `node --expose-gc` subprocess so forced collection is real
// and no Vitest state keeps a dropped client reachable. Assertions are structural counts.
interface Sizes {
  readonly reporters: number;
  readonly leaseHolders: number;
}
interface ProbeResult {
  readonly [key: string]: unknown;
  readonly droppedBreakerBeforeDrop: number;
  readonly heldBreakerPostsInWindow: number;
  readonly heldRoundsInWindow: number;
  readonly reservations: number;
  readonly registrationDerefs: number;
  readonly sizesAfterDrop: Sizes;
  readonly sizesAfterAllDropped: Sizes;
  readonly lanes: Record<
    string,
    { clients: number; providersAlive: number; leaseHoldersAlive: number }
  >;
}

function probe(scenario: string): ProbeResult {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/unclosed-client-retention.mts", scenario],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ProbeResult;
}

describe("clients dropped without close()", () => {
  it("release idle, after-call and run-leased providers and prune their lease holders", () => {
    const { lanes } = probe("stage-a");
    for (const lane of ["idle", "after-call", "leased-run"]) {
      expect(lanes[lane]?.clients, lane).toBe(20);
      expect(lanes[lane]?.providersAlive, lane).toBeLessThanOrEqual(1);
      expect(lanes[lane]?.leaseHoldersAlive, lane).toBeLessThanOrEqual(1);
    }
    expect(lanes["leased-run"]).toMatchObject({ leaseGrants: 20 });
  }, 65_000);

  it("stop rounds and breaker heartbeats after collection while a held idle client heartbeats", () => {
    const result = probe("heartbeat");
    expect(result.droppedBreakerBeforeDrop).toBeGreaterThan(0);
    expect(result).toMatchObject({
      droppedClients: 10,
      droppedProvidersAlive: 0,
      droppedReportersAlive: 0,
      droppedBreakerPostsInWindow: 0,
      droppedRequestsInWindow: 0,
      droppedRoundsInWindow: 0,
      heldProviderAlive: true,
    });
    expect(result.heldBreakerPostsInWindow).toBeGreaterThanOrEqual(2);
    expect(result.heldRoundsInWindow).toBeGreaterThanOrEqual(2);
  }, 65_000);

  it.each([
    ["heartbeat-every-tick", "succeeds"],
    ["heartbeat-every-tick-failing", "fails"],
  ])("release after a breaker cycle due every tick settles (%s: the report %s)", (scenario) => {
    const result = probe(scenario);
    expect(result.droppedBreakerBeforeDrop).toBeGreaterThan(0);
    expect(result).toMatchObject({
      droppedClients: 10,
      droppedProvidersAlive: 0,
      droppedReportersAlive: 0,
      droppedBreakerPostsInWindow: 0,
      droppedRequestsInWindow: 0,
      droppedRoundsInWindow: 0,
      heldProviderAlive: true,
    });
    expect(result.heldBreakerPostsInWindow).toBeGreaterThanOrEqual(2);
  }, 65_000);

  it("stay rooted through failed and delayed first sends, deliver once, then release", () => {
    const result = probe("retry-delivery");
    expect(result.reservations).toBeGreaterThan(0);
    expect(result).toMatchObject({
      confirmFailures: result.reservations,
      confirmedOnce: result.reservations,
      confirmedMoreThanOnce: 0,
      ingestedOnce: 6,
      ingestedMoreThanOnce: 0,
      providersAlive: 0,
      reportersAlive: 0,
      requestsAfterCollection: 0,
    });
  }, 65_000);

  it("leave the Node exit registry with linear registration work", () => {
    const result = probe("registry");
    expect(result).toMatchObject({
      liveRegistrations: 200,
      sizesWhileHeld: { reporters: 200, leaseHolders: 200 },
      droppedParticipantsAlive: 0,
    });
    // A rescan on every registration visits ~n²/2 entries per population.
    expect(result.registrationDerefs).toBeLessThanOrEqual(4 * 200);
    const afterDrop = result.sizesAfterDrop;
    expect(afterDrop.reporters).toBeLessThanOrEqual(200);
    expect(afterDrop.leaseHolders).toBeLessThanOrEqual(200);
    const afterAll = result.sizesAfterAllDropped;
    expect(afterAll.reporters).toBeLessThanOrEqual(1);
    expect(afterAll.leaseHolders).toBeLessThanOrEqual(1);
  }, 65_000);

  it("constructed inside run() lets that run retire and report its lease before close", () => {
    const result = probe("run-retire");
    expect(result).toMatchObject({
      pinnedOwnerEntries: 0,
      firstRunRetired: true,
      leaseGrants: 6,
      surrendersBeforeClose: 6,
      spentTokensReportedBeforeClose: 12,
    });
  }, 65_000);

  it("covers the AI SDK middleware: dropped handles release their reporter and stop", () => {
    const result = probe("middleware");
    expect(result).toMatchObject({
      droppedHandles: 10,
      ingestedBeforeDrop: 5,
      droppedReportersAlive: 0,
      droppedLeaseHoldersAlive: 0,
      droppedRequestsInWindow: 0,
      droppedRoundsInWindow: 0,
      registrySizes: { reporters: 1, leaseHolders: 1 },
    });
    expect(result.heldRoundsInWindow).toBeGreaterThanOrEqual(2);
  }, 65_000);
});

describe("reporter flush cadence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts outside the run that first used the reporter", async () => {
    vi.useFakeTimers();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 10,
      fetch: async () => new Response(null, { status: 204 }),
    });
    const runsSeenByRounds: unknown[] = [];
    vi.spyOn(reporter, "_flushRemaining").mockImplementation(async () => {
      runsSeenByRounds.push(getCurrentRun()?.agentRunId ?? null);
      return false;
    });

    run("first-request", () => reporter.start());
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(runsSeenByRounds).toEqual([null, null]);
    await reporter.close(0);
  });

  it("keeps a strong root and its cadence where WeakRef is unavailable", async () => {
    vi.useFakeTimers();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 10,
      fetch: async () => new Response(null, { status: 204 }),
    });
    const flush = vi.spyOn(reporter, "_flushRemaining").mockResolvedValue(false);
    vi.stubGlobal("WeakRef", undefined);

    reporter.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(flush).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    await reporter.close(0);
  });
});
