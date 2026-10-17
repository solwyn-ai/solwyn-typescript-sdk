import { afterEach, describe, expect, it, vi } from "vitest";
import { resetReadOnlyKeyDiagnosticForTest } from "../../src/read-only-key";
import type { FetchLike } from "../../src/transport";
import {
  type UntrackedSurfaceObservation,
  UntrackedSurfaceReporter,
} from "../../src/untracked-reporter";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const FIRST_SEEN = Date.UTC(2026, 7, 13, 12);

function reportId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function observation(
  overrides: Partial<UntrackedSurfaceObservation> = {},
): UntrackedSurfaceObservation {
  return {
    provider: "openai",
    clientShape: "openai_sdk",
    surface: "responses.create",
    ruleKind: "unmetered_spend",
    capabilityScope: null,
    posture: "warn",
    ...overrides,
  };
}

describe("UntrackedSurfaceReporter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one shutdown deadline across an active send and the final due batch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const batches: number[] = [];
    const signals: AbortSignal[] = [];
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      shutdownDeadline: 4000,
      fetch: (_url, init) => {
        batches.push(JSON.parse(String(init?.body)).length);
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>(() => {});
      },
    });
    for (let index = 0; index < 512; index += 1) {
      reporter.observe(observation({ surface: `resource.entry_${index}` }));
    }
    const active = reporter.flushDue();
    await vi.advanceTimersByTimeAsync(2_000);
    const closing = reporter.close();
    expect(reporter.close()).toBe(closing);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    await active;
    expect(batches).toEqual([100]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(reporter.observe(observation({ surface: "newAfterClose" }))).toBeUndefined();
    await reporter.flushDue();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(batches).toEqual([100]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes a successful final due cycle and clears its shutdown timer", async () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch: async (_url, init) => {
        batches.push(JSON.parse(String(init?.body)).length);
        return new Response(null, { status: 204 });
      },
    });
    for (let index = 0; index < 101; index += 1) {
      reporter.observe(observation({ surface: `resource.entry_${index}` }));
    }
    await reporter.close();
    expect(batches).toEqual([100, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("posts one canonical async report immediately for the first observation", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => 0,
      randomUUID: () => "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    });

    reporter.observe(observation());
    await reporter.flushDue();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.solwyn.ai/api/v1/untracked-surfaces");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual([
      {
        provider: "openai",
        client_shape: "openai_sdk",
        mode: "async",
        surface: "responses.create",
        rule_kind: "unmetered_spend",
        capability_scope: null,
        posture: "warn",
        occurrences: 1,
        first_seen_at: "2026-08-13T12:00:00Z",
        last_seen_at: "2026-08-13T12:00:00Z",
        sdk_instance_id: "sdk-instance-1",
        report_id: "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      },
    ]);
    expect(Object.keys(JSON.parse(String(calls[0]?.init.body))[0])).toEqual([
      "provider",
      "client_shape",
      "mode",
      "surface",
      "rule_kind",
      "capability_scope",
      "posture",
      "occurrences",
      "first_seen_at",
      "last_seen_at",
      "sdk_instance_id",
      "report_id",
    ]);
  });

  it("retries the same report unchanged and sends later occurrences under a separate id", async () => {
    let monotonicNow = 0;
    let wallNow = FIRST_SEEN;
    let idSequence = 0;
    const bodies: unknown[][] = [];
    let responseNumber = 0;
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      responseNumber += 1;
      return Promise.resolve(new Response(null, { status: responseNumber === 1 ? 500 : 204 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => wallNow,
      monotonicClock: () => monotonicNow,
      randomUUID: () => reportId(++idSequence),
      random: () => 1,
    });

    reporter.observe(observation());
    await expect(reporter.flushDue()).resolves.toBeUndefined();
    wallNow += 60_000;
    reporter.observe(observation());

    monotonicNow = 999;
    await reporter.flushDue();
    expect(bodies).toHaveLength(1);

    monotonicNow = 1000;
    await reporter.flushDue();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.[0]).toMatchObject({
      occurrences: 1,
      report_id: reportId(1),
    });
    expect(bodies[1]).toEqual(bodies[0]);
    monotonicNow = 900_000;
    await reporter.flushDue();
    expect(bodies).toHaveLength(3);
    expect(bodies[2]?.[0]).toMatchObject({
      occurrences: 1,
      first_seen_at: "2026-08-13T12:00:00Z",
      last_seen_at: "2026-08-13T12:01:00Z",
      report_id: reportId(2),
    });
  });

  it("widens wall-clock bounds even when observations arrive after a clock rollback", async () => {
    let wallNow = FIRST_SEEN + 60_000;
    let body: unknown[] = [];
    const fetch: FetchLike = (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => wallNow,
      monotonicClock: () => 0,
      randomUUID: () => reportId(1),
    });

    reporter.observe(observation());
    wallNow = FIRST_SEEN - 60_000;
    reporter.observe(observation());
    await reporter.flushDue();

    expect(body[0]).toMatchObject({
      occurrences: 2,
      first_seen_at: "2026-08-13T11:59:00Z",
      last_seen_at: "2026-08-13T12:01:00Z",
    });
  });

  it("coalesces concurrent flushes and keeps same-key observations pending until cadence", async () => {
    let monotonicNow = 0;
    let idSequence = 0;
    const bodies: unknown[][] = [];
    let releaseFirst: ((response: Response) => void) | undefined;
    let callNumber = 0;
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      callNumber += 1;
      if (callNumber === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => monotonicNow,
      randomUUID: () => reportId(++idSequence),
    });

    reporter.observe(observation());
    const first = reporter.flushDue();
    const concurrent = reporter.flushDue();
    expect(concurrent).toBe(first);
    reporter.observe(observation());
    expect(reporter.flushDue()).toBe(first);
    releaseFirst?.(new Response(null, { status: 204 }));
    await first;
    expect(bodies).toHaveLength(1);

    monotonicNow = 900_000;
    await reporter.flushDue();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.[0]).toMatchObject({ occurrences: 1 });
    expect(bodies[1]?.[0]).toMatchObject({ occurrences: 1 });
  });

  it("drains a distinct due key before the coalesced flush resolves", async () => {
    let idSequence = 0;
    const bodies: unknown[][] = [];
    const releases: Array<(response: Response) => void> = [];
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((resolve) => {
        releases.push(resolve);
      });
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => 0,
      randomUUID: () => reportId(++idSequence),
    });

    reporter.observe(observation());
    const first = reporter.flushDue();
    reporter.observe(observation({ surface: "files.create" }));
    const coalesced = reporter.flushDue();
    expect(coalesced).toBe(first);
    let settled = false;
    void coalesced.then(() => {
      settled = true;
    });

    releases[0]?.(new Response(null, { status: 204 }));
    try {
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
      expect(settled).toBe(false);
      expect(bodies[0]?.[0]).toMatchObject({ surface: "responses.create", occurrences: 1 });
      expect(bodies[1]?.[0]).toMatchObject({ surface: "files.create", occurrences: 1 });
    } finally {
      releases[1]?.(new Response(null, { status: 204 }));
    }
    await coalesced;
    expect(settled).toBe(true);
  });

  it("clamps each delta to one billion and advances only the built cursor", async () => {
    let monotonicNow = 0;
    let idSequence = 0;
    const bodies: unknown[][] = [];
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 299 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => monotonicNow,
      randomUUID: () => reportId(++idSequence),
    });

    reporter.observe(observation({ occurrences: 1_000_000_005 }));
    await reporter.flushDue();
    monotonicNow = 900_000;
    await reporter.flushDue();

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.[0]).toMatchObject({
      occurrences: 1_000_000_000,
      report_id: reportId(1),
    });
    expect(bodies[1]?.[0]).toMatchObject({
      occurrences: 5,
      report_id: reportId(2),
    });
  });

  it("uses deterministic 100-item batches and continues after a sibling batch fails", async () => {
    let monotonicNow = 0;
    let idSequence = 0;
    const bodies: Array<Array<{ surface: string; report_id: string }>> = [];
    let callNumber = 0;
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      callNumber += 1;
      return Promise.resolve(new Response(null, { status: callNumber === 1 ? 503 : 204 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => monotonicNow,
      randomUUID: () => reportId(++idSequence),
    });
    for (let index = 0; index < 101; index += 1) {
      reporter.observe(observation({ surface: `responses.operation_${index}` }));
    }

    await expect(reporter.flushDue()).resolves.toBeUndefined();
    expect(bodies.map((batch) => batch.length)).toEqual([100, 1]);
    expect(bodies.flat().map((report) => report.surface)).toEqual(
      Array.from({ length: 101 }, (_, index) => `responses.operation_${index}`),
    );
    const firstAttemptIds = bodies[0]?.map((report) => report.report_id);

    monotonicNow = 900_000;
    await reporter.flushDue();
    expect(bodies.map((batch) => batch.length)).toEqual([100, 1, 100]);
    expect(bodies[2]?.map((report) => report.surface)).toEqual(
      Array.from({ length: 100 }, (_, index) => `responses.operation_${index}`),
    );
    expect(bodies[2]?.map((report) => report.report_id)).toEqual(firstAttemptIds);
  });

  it("flushes all unsent occurrences on close without waiting for the per-key interval", async () => {
    const counts: number[] = [];
    let sequence = 0;
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      monotonicClock: () => 0,
      randomUUID: () => reportId(++sequence),
      fetch: async (_url, init) => {
        counts.push(
          ...JSON.parse(String(init?.body)).map(
            (report: { occurrences: number }) => report.occurrences,
          ),
        );
        return new Response(null, { status: 204 });
      },
    });
    reporter.observe(observation());
    await reporter.flushDue();
    reporter.observe(observation({ occurrences: 99 }));
    await reporter.close();
    expect(counts).toEqual([1, 99]);
  });

  it("retries a pending report at close before sending its later occurrences", async () => {
    let now = 0;
    let sequence = 0;
    const bodies: Array<Array<{ report_id: string; occurrences: number }>> = [];
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      monotonicClock: () => now,
      randomUUID: () => reportId(++sequence),
      random: () => 1,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: bodies.length === 1 ? 500 : 204 });
      },
    });
    reporter.observe(observation());
    await reporter.flushDue();
    reporter.observe(observation({ occurrences: 99 }));
    now = 100;
    await reporter.close();

    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]?.[0]).toMatchObject({ report_id: reportId(2), occurrences: 99 });
  });

  it("keeps a server Retry-After hold during the final flush", async () => {
    let now = 0;
    const bodies: unknown[] = [];
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      monotonicClock: () => now,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      },
    });
    reporter.observe(observation());
    await reporter.flushDue();
    reporter.observe(observation({ occurrences: 99 }));
    now = 100;
    await reporter.close();

    expect(bodies).toHaveLength(1);
  });

  it("aggregates retry exhaustion warnings at most once per minute", async () => {
    let now = 0;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      monotonicClock: () => now,
      maxSendAttempts: 1,
      logger,
      fetch: async () => new Response(null, { status: 500 }),
    });
    const exhaustionWarnings = () =>
      logger.warn.mock.calls.filter(([message]) =>
        String(message).startsWith("untracked.retry_exhausted"),
      );
    for (let index = 0; index < 101; index += 1) {
      reporter.observe(observation({ surface: `resource.entry_${index}` }));
    }
    await reporter.flushDue();
    expect(exhaustionWarnings()).toEqual([["untracked.retry_exhausted: reports=%d", 100]]);

    now = 59_999;
    reporter.observe(observation({ surface: "resource.later" }));
    await reporter.flushDue();
    expect(exhaustionWarnings()).toHaveLength(1);
    now = 60_000;
    reporter.observe(observation({ surface: "resource.latest" }));
    await reporter.flushDue();
    expect(exhaustionWarnings()).toEqual([
      ["untracked.retry_exhausted: reports=%d", 100],
      ["untracked.retry_exhausted: reports=%d", 3],
    ]);
    await reporter.close();
  });

  it.each([
    { timeout: 0, leftover: 1 },
    { timeout: 5000, leftover: 2 },
  ])("logs remaining retry exhaustions once at close with a $timeout ms budget", async ({
    timeout,
    leftover,
  }) => {
    const warn = vi.fn();
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      monotonicClock: () => 0,
      maxSendAttempts: 1,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      fetch: async () => new Response(null, { status: 500 }),
    });
    for (let index = 0; index < 101; index++) {
      reporter.observe(observation({ surface: `resource.entry_${index}` }));
    }
    await reporter.flushDue();
    reporter.observe(observation({ surface: "resource.onClose" }));
    await reporter.close(timeout);
    await reporter.close(timeout);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).startsWith("untracked.retry_exhausted"),
      ),
    ).toEqual([
      ["untracked.retry_exhausted: reports=%d", 100],
      ["untracked.retry_exhausted: reports=%d", leftover],
    ]);
  });

  it.each([400, 403, 422])("logs HTTP %d once and stops retrying refused keys", async (status) => {
    const warn = vi.fn();
    const fetch = vi.fn(async () => new Response(null, { status }));
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      fetch,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    reporter.observe(observation());
    await reporter.flushDue();
    reporter.observe(observation());
    await reporter.close();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "untracked.send_failed: status=%s exc_type=%s",
      status,
      "TransportHttpError",
    );
  });

  it("surfaces a definitive refusal even immediately after a transient failure", async () => {
    let now = 0;
    const statuses = [500, 422];
    const warn = vi.fn();
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      monotonicClock: () => now,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      fetch: async () => new Response(null, { status: statuses.shift() }),
    });
    reporter.observe(observation());
    await reporter.flushDue();
    now = 1000;
    await reporter.flushDue();
    expect(warn).toHaveBeenCalledWith(
      "untracked.send_failed: status=%s exc_type=%s",
      422,
      "TransportHttpError",
    );
    await reporter.close();
  });

  it("routes read-only credentials through the shared diagnostic and stops advisory delivery", async () => {
    resetReadOnlyKeyDiagnosticForTest();
    const warn = vi.fn();
    const error = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { code: "read_only_key" } }), { status: 403 }),
    );
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      fetch,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error },
    });
    reporter.observe(observation());
    await reporter.flushDue();
    reporter.observe(observation({ surface: "files.create" }));
    await reporter.close();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("read_only_key");
    expect(warn).not.toHaveBeenCalled();
  });

  it("honors Retry-After and keeps rate-limited report identities stable", async () => {
    let now = 0;
    let sequence = 0;
    const bodies: unknown[] = [];
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      monotonicClock: () => now,
      maxSendAttempts: 1,
      randomUUID: () => reportId(++sequence),
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length < 3
          ? new Response(null, { status: 429, headers: { "Retry-After": "60" } })
          : new Response(null, { status: 204 });
      },
    });
    reporter.observe(observation());
    await reporter.flushDue();
    now = 59_999;
    await reporter.flushDue();
    expect(bodies).toHaveLength(1);
    now = 60_000;
    await reporter.flushDue();
    expect(bodies).toHaveLength(2);
    now = 120_000;
    await reporter.flushDue();
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    await reporter.close();
  });

  it("eventually disposes a permanently rate-limited report", async () => {
    let now = 0;
    const fetch = vi.fn(
      async () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
    );
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      fetch,
      maxSendAttempts: 1,
      monotonicClock: () => now,
    });
    reporter.observe(observation());
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await reporter.flushDue();
      now += 60_000;
    }
    await reporter.close();
    expect(fetch).toHaveBeenCalledTimes(20);
  });

  it("keeps the endpoint Retry-After hold after a report exhausts its retries", async () => {
    let now = 0;
    const fetch = vi.fn(async () =>
      fetch.mock.calls.length <= 20
        ? new Response(null, { status: 429, headers: { "Retry-After": "60" } })
        : new Response(null, { status: 204 }),
    );
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.test", API_KEY, {
      sdkInstanceId: "synthetic",
      fetch,
      maxSendAttempts: 1,
      monotonicClock: () => now,
    });
    try {
      reporter.observe(observation());
      for (let attempt = 0; attempt < 20; attempt += 1) {
        now = attempt * 60_000;
        await reporter.flushDue();
      }
      expect(fetch).toHaveBeenCalledTimes(20);
      reporter.observe(observation({ surface: "files.create" }));
      await reporter.flushDue();
      expect(fetch).toHaveBeenCalledTimes(20);
      now = 20 * 60_000 - 1;
      await reporter.flushDue();
      expect(fetch).toHaveBeenCalledTimes(20);
      now += 1;
      await reporter.flushDue();
      expect(fetch).toHaveBeenCalledTimes(21);
    } finally {
      await reporter.close();
    }
  });

  it("retains the first 512 distinct keys and ignores later distinct keys", async () => {
    let idSequence = 0;
    const bodies: Array<Array<{ surface: string }>> = [];
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 202 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => 0,
      randomUUID: () => reportId(++idSequence),
    });
    for (let index = 0; index < 513; index += 1) {
      reporter.observe(observation({ surface: `resource.entry_${index}` }));
    }

    await reporter.flushDue();
    const surfaces = bodies.flat().map((report) => report.surface);
    expect(bodies.map((batch) => batch.length)).toEqual([100, 100, 100, 100, 100, 12]);
    expect(surfaces).toHaveLength(512);
    expect(surfaces[0]).toBe("resource.entry_0");
    expect(surfaces[511]).toBe("resource.entry_511");
    expect(surfaces).not.toContain("resource.entry_512");
  });

  it("does not claim admission for malformed observations or a capacity-dropped wire key", () => {
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      wallClock: () => FIRST_SEEN,
    });

    expect(
      reporter.observe({
        ...observation(),
        provider: "private-provider",
      } as unknown as UntrackedSurfaceObservation),
    ).toBeUndefined();
    for (let index = 0; index < 512; index += 1) {
      expect(reporter.observe(observation({ surface: `resource.entry_${index}` }))).toEqual({
        status: "admitted",
      });
    }
    expect(reporter.observe(observation({ surface: "resource.entry_512" }))).toBeUndefined();
  });

  it("keeps an incompatible local shape out of the wire ledger without blocking valid siblings", async () => {
    let monotonicNow = 0;
    let idSequence = 0;
    const bodies: Array<Array<{ client_shape: string; report_id: string }>> = [];
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => monotonicNow,
      randomUUID: () => reportId(++idSequence),
    });

    reporter.observe(observation({ clientShape: "bedrock_v3" }));
    reporter.observe(observation({ surface: "chat.completions.create" }));
    await reporter.flushDue();
    expect(bodies).toEqual([
      [
        expect.objectContaining({
          client_shape: "openai_sdk",
          report_id: reportId(1),
        }),
      ],
    ]);
    expect(idSequence).toBe(1);

    await reporter.flushDue();
    expect(bodies).toHaveLength(1);
    expect(idSequence).toBe(1);

    monotonicNow = 900_000;
    await reporter.flushDue();
    expect(bodies).toHaveLength(1);
    expect(idSequence).toBe(1);
  });

  it("keeps incompatible local client shapes local without consuming reporter capacity", async () => {
    let wallClockCalls = 0;
    let idSequence = 0;
    const warnings = vi.fn();
    const calls: unknown[][] = [];
    const fetch: FetchLike = (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => {
        wallClockCalls += 1;
        return FIRST_SEEN;
      },
      monotonicClock: () => 0,
      randomUUID: () => reportId(++idSequence),
      logger: { debug: vi.fn(), info: vi.fn(), warn: warnings, error: vi.fn() },
    });

    expect(reporter.observe(observation({ clientShape: "bedrock_v3" }))).toEqual({
      status: "local_only",
      reason: "client_shape_not_in_wire",
      clientShape: "bedrock_v3",
    });
    expect(reporter.observe(observation({ clientShape: "undeclared_sdk" }))).toEqual({
      status: "local_only",
      reason: "client_shape_not_in_wire",
      clientShape: "undeclared_sdk",
    });
    for (let index = 0; index < 512; index += 1) {
      reporter.observe(observation({ clientShape: "bedrock_v3", surface: `local.entry_${index}` }));
    }
    expect(reporter.observe(observation())).toEqual({ status: "admitted" });
    await reporter.flushDue();

    expect(wallClockCalls).toBe(1);
    expect(warnings).toHaveBeenCalledTimes(2);
    expect(warnings.mock.calls.map((call) => call.slice(1))).toEqual([
      ["bedrock_v3"],
      ["undeclared_sdk"],
    ]);
    expect(idSequence).toBe(1);
    expect(calls).toEqual([
      [
        expect.objectContaining({
          client_shape: "openai_sdk",
          report_id: reportId(1),
        }),
      ],
    ]);
  });

  it("rejects malformed labels before storage but retains structural wire-poison paths", async () => {
    let idSequence = 0;
    const bodies: Array<Array<{ surface: string; report_id: string }>> = [];
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => 0,
      randomUUID: () => reportId(++idSequence),
    });

    for (const malformed of [
      observation({ surface: "prompt derived value" }),
      { ...observation(), clientShape: "private-shape" },
      { ...observation(), provider: "private-provider" },
      { ...observation(), ruleKind: "private-kind" },
      { ...observation(), capabilityScope: "private-scope" },
      { ...observation(), posture: "raise" },
    ]) {
      reporter.observe(malformed as UntrackedSurfaceObservation);
    }
    reporter.observe(observation({ surface: "x".repeat(129) }));
    reporter.observe(observation({ surface: "chat.completions.create" }));

    await reporter.flushDue();
    expect(idSequence).toBe(2);
    expect(bodies).toEqual([
      [
        expect.objectContaining({
          surface: "chat.completions.create",
          report_id: reportId(2),
        }),
      ],
    ]);
    expect(JSON.stringify(bodies)).not.toContain("prompt derived value");
    expect(JSON.stringify(bodies)).not.toContain("private-");
  });

  it("times out silently after exactly ten seconds with no transport retry", async () => {
    vi.useFakeTimers();
    let fetchCalls = 0;
    let aborts = 0;
    const fetch: FetchLike = (_url, init) => {
      fetchCalls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborts += 1;
            reject(new Error("private upstream failure"));
          },
          { once: true },
        );
      });
    };
    const reporter = new UntrackedSurfaceReporter("https://api.solwyn.ai", API_KEY, {
      sdkInstanceId: "sdk-instance-1",
      fetch,
      wallClock: () => FIRST_SEEN,
      monotonicClock: () => 0,
      randomUUID: () => reportId(1),
    });
    reporter.observe(observation());

    const flush = reporter.flushDue();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(aborts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(flush).resolves.toBeUndefined();
    expect(aborts).toBe(1);
    expect(fetchCalls).toBe(1);
  });
});
