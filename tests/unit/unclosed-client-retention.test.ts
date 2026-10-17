import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import { getCurrentRun } from "../../src/run-context";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

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

async function probe(scenario: string): Promise<ProbeResult> {
  return JSON.parse(await runGcProbe("unclosed-client-retention", scenario)) as ProbeResult;
}

describe("clients dropped without close()", () => {
  it(
    "release idle, after-call and run-leased providers and prune their lease holders",
    async () => {
      const { lanes } = await probe("stage-a");
      for (const lane of ["idle", "after-call", "leased-run"]) {
        expect(lanes[lane]?.clients, lane).toBe(20);
        expect(lanes[lane]?.providersAlive, lane).toBe(0);
        expect(lanes[lane]?.leaseHoldersAlive, lane).toBe(0);
      }
      expect(lanes["leased-run"]).toMatchObject({ leaseGrants: 20 });
    },
    gcProbeTimeout,
  );

  it(
    "stop rounds and breaker heartbeats after collection while a held idle client heartbeats",
    async () => {
      const result = await probe("heartbeat");
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
    },
    gcProbeTimeout,
  );

  it.each([
    ["heartbeat-every-tick", "succeeds"],
    ["heartbeat-every-tick-failing", "fails"],
  ])(
    "release after a breaker cycle due every tick settles (%s: the report %s)",
    async (scenario) => {
      const result = await probe(scenario);
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
    },
    gcProbeTimeout,
  );

  it(
    "stay rooted through failed and delayed first sends, deliver once, then release",
    async () => {
      const result = await probe("retry-delivery");
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
    },
    gcProbeTimeout,
  );

  it(
    "leave the Node exit registry with linear registration work",
    async () => {
      const result = await probe("registry");
      expect(result).toMatchObject({
        liveRegistrations: 200,
        sizesWhileHeld: { reporters: 200, leaseHolders: 200 },
        droppedParticipantsAlive: 0,
      });
      // A rescan on every registration visits ~n²/2 entries per population.
      expect(result.registrationDerefs).toBeLessThanOrEqual(4 * 200);
      const afterDrop = result.sizesAfterDrop;
      expect(afterDrop.reporters).toBe(200);
      expect(afterDrop.leaseHolders).toBe(200);
      const afterAll = result.sizesAfterAllDropped;
      expect(afterAll.reporters).toBe(0);
      expect(afterAll.leaseHolders).toBe(0);
    },
    gcProbeTimeout,
  );

  it(
    "constructed inside run() lets that run retire and report its lease before close",
    async () => {
      const result = await probe("run-retire");
      expect(result).toMatchObject({
        pinnedOwnerEntries: 0,
        firstRunRetired: true,
        leaseGrants: 6,
        surrendersBeforeClose: 6,
        spentTokensReportedBeforeClose: 12,
      });
    },
    gcProbeTimeout,
  );

  it(
    "covers the AI SDK middleware: dropped handles release their reporter and stop",
    async () => {
      const result = await probe("middleware");
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
    },
    gcProbeTimeout,
  );
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
