import { describe, expect, it } from "vitest";
import {
  type ReleaseAttempt,
  ReleaseDispatcher,
  type ReleaseDispatcherOptions,
  type ReleaseOutcome,
} from "../../src/release-dispatcher";
import type { LeaseSurrenderRequest } from "../../src/types";

function request(leaseId: string, overrides: Partial<LeaseSurrenderRequest> = {}) {
  return { lease_id: leaseId, holder_id: "holder", generation: 1, spent_tokens: 0, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

function dispatcher(
  send: ReleaseDispatcherOptions["send"],
  overrides: Partial<ReleaseDispatcherOptions> = {},
): ReleaseDispatcher {
  return new ReleaseDispatcher({
    send,
    now: () => 0,
    attemptTimeoutMs: 1_000,
    maxAttempts: 2,
    itemBudgetMs: 2_000,
    ...overrides,
  });
}

describe("ReleaseDispatcher", () => {
  it("merges identical payloads and reports the outcome to every submitter", async () => {
    const gate = deferred<ReleaseAttempt>();
    const sent: LeaseSurrenderRequest[] = [];
    const releases = dispatcher((item) => {
      sent.push(item);
      return gate.promise;
    });
    const outcomes: Array<[string, ReleaseOutcome]> = [];
    releases.submit(request("same", { spent_tokens: 2 }), {
      onOutcome: (outcome) => outcomes.push(["first", outcome]),
    });
    releases.submit(request("same", { spent_tokens: 2 }), {
      onOutcome: (outcome) => outcomes.push(["second", outcome]),
    });
    // A different spent snapshot or a successor generation is never merged away.
    releases.submit(request("same", { spent_tokens: 3 }));
    releases.submit(request("same", { generation: 2, spent_tokens: 2 }));
    expect(sent).toHaveLength(3);
    expect(releases.counts()).toMatchObject({ enqueued: 3, merged: 1 });

    gate.resolve({ result: "refused", settled: null });
    await releases.whenIdle();
    expect(outcomes).toEqual([
      ["first", { kind: "dropped", reason: "refused" }],
      ["second", { kind: "dropped", reason: "refused" }],
    ]);
    expect(releases.counts()).toMatchObject({ enqueued: 3, sent: 0 });
    expect(releases.counts().dropped.refused).toBe(3);
  });

  it("keeps the slot of a request that ignores abort until it settles", async () => {
    const underlying = deferred<void>();
    const attempts: number[] = [];
    let now = 0;
    const releases = dispatcher(
      async (_item, timeoutMs) => {
        attempts.push(timeoutMs);
        // The bounded wait ended, but the underlying request is still running.
        return { result: "timeout", settled: attempts.length === 1 ? underlying.promise : null };
      },
      { now: () => now },
    );
    releases.submit(request("slow"));
    await turns();
    expect(attempts).toEqual([1_000]);
    expect(releases.active).toBe(1);
    now = 1_500;
    underlying.resolve();
    await releases.whenIdle();
    // The retry starts only after the first request released its slot, bounded by the deadline.
    expect(attempts).toEqual([1_000, 500]);
    expect(releases.active).toBe(0);
    expect(releases.counts().dropped.timeout).toBe(1);
  });

  it("classifies expiry lazily at enqueue and a thrown attempt as a local error", async () => {
    let now = 0;
    const releases = dispatcher(
      async () => {
        throw new Error("local failure");
      },
      { now: () => now },
    );
    const outcomes: ReleaseOutcome[] = [];
    releases.submit(request("late"), { deadline: 0, onOutcome: (o) => outcomes.push(o) });
    releases.submit(request("close"), {
      deadline: 0,
      closeTime: true,
      onOutcome: (o) => outcomes.push(o),
    });
    now = 10;
    releases.submit(request("throws"), { onOutcome: (o) => outcomes.push(o) });
    await releases.whenIdle();
    expect(outcomes).toEqual([
      { kind: "dropped", reason: "expired" },
      { kind: "dropped", reason: "shutdown_deadline" },
      { kind: "dropped", reason: "local_error" },
    ]);
    const counts = releases.counts();
    expect(counts.enqueued).toBe(3);
    expect(counts.sent).toBe(0);
  });

  it("gives close-time items one attempt and no pending cap", async () => {
    const gate = deferred<void>();
    let calls = 0;
    const releases = dispatcher(async () => {
      calls += 1;
      await gate.promise;
      return { result: "timeout", settled: null };
    });
    for (let index = 0; index < 100; index++) {
      releases.submit(request(`close-${index}`), { deadline: 1_000, closeTime: true });
    }
    expect(releases.active).toBe(4);
    expect(releases.pending).toBe(96);
    expect(releases.counts().dropped.queue_full).toBe(0);
    expect(releases.dropCloseTimeQueued()).toBe(96);
    gate.resolve();
    await releases.whenIdle();
    expect(calls).toBe(4);
    expect(releases.counts().dropped).toMatchObject({ timeout: 4, shutdown_deadline: 96 });
  });

  it("holds nothing once idle", async () => {
    const releases = dispatcher(async () => ({ result: "sent", settled: null }));
    releases.submit(request("one"));
    await releases.whenIdle();
    expect(releases.active).toBe(0);
    expect(releases.pending).toBe(0);
    expect(releases.hasFreeWorker).toBe(true);
    await expect(releases.whenIdle()).resolves.toBeUndefined();
    expect(releases.counts()).toMatchObject({ enqueued: 1, sent: 1 });
  });
});
