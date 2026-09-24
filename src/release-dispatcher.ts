/**
 * Bounded dispatcher for lease surrenders (courtesy releases).
 *
 * A surrender only returns unspent reserved tokens early: lease-tagged confirmations settle
 * spend, and the control plane runs the same release accounting when a lease expires. Release
 * work is therefore bounded instead of retried: at most {@link RELEASE_WORKERS} requests are in
 * flight, at most {@link RELEASE_MAX_PENDING} ordinary items wait, and every item has a deadline.
 * A refused, overflowing or expired item is dropped and counted by reason.
 *
 * The dispatcher starts no timers. Deadlines are evaluated lazily when an item is submitted and
 * when a worker dequeues. Workers exist only while there is work, so an idle dispatcher holds no
 * pending promise. A request that ignores abort keeps its worker slot until it settles.
 *
 * Every queue operation is amortized O(1) per item, so close() can drain an uncapped population
 * within its deadline. Ordinary and close-time items wait in separate FIFOs. Within each FIFO
 * deadlines are non-decreasing (ordinary items share one item budget from a monotonic clock, and
 * close fencing clamps every queued item to one close deadline), so expiry only inspects the
 * head. An item whose deadline has passed is still classified when a worker takes it.
 *
 * Edge-safe: no `node:*` imports, and no prompt or response content is ever seen here.
 */

import type { LeaseSurrenderRequest } from "./types";

/** Maximum concurrent surrender requests for one enforcer. */
export const RELEASE_WORKERS = 4;

/** Maximum ordinary items waiting for a worker; close-time items are uncapped. */
export const RELEASE_MAX_PENDING = 64;

/** Every reason an item can end without a successful answer. */
export const RELEASE_DROP_REASONS = [
  "refused",
  "timeout",
  "unreachable",
  "breaker_open",
  "queue_full",
  "expired",
  "dispatch_failed",
  "setup_failed",
  "local_error",
  "cancelled",
  "shutdown_deadline",
] as const;
export type ReleaseDropReason = (typeof RELEASE_DROP_REASONS)[number];

export type ReleaseOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "dropped"; readonly reason: ReleaseDropReason };

/** The classified result of one surrender attempt. */
export type ReleaseAttemptResult =
  | "sent"
  | "refused"
  | "timeout"
  | "unreachable"
  | "breaker_open"
  | "setup_failed"
  | "local_error";

export interface ReleaseAttempt {
  readonly result: ReleaseAttemptResult;
  /** Settles when the underlying request settles, including one that ignored abort. */
  readonly settled: Promise<unknown> | null;
}

export interface ReleaseCounts {
  readonly enqueued: number;
  readonly merged: number;
  readonly sent: number;
  readonly dropped: Readonly<Record<ReleaseDropReason, number>>;
}

export interface ReleaseDispatcherOptions {
  /** Perform one attempt bounded by `timeoutMs`; must classify rather than throw. */
  readonly send: (request: LeaseSurrenderRequest, timeoutMs: number) => Promise<ReleaseAttempt>;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** Per-attempt bound; each attempt uses min(this, remaining). */
  readonly attemptTimeoutMs: number;
  /** Attempts for an ordinary item; only a timeout is retried. */
  readonly maxAttempts: number;
  /** Ordinary item deadline, measured from submission. */
  readonly itemBudgetMs: number;
  /** Observes every drop once, after it is counted. */
  readonly onDrop?: (reason: ReleaseDropReason) => void;
  /** A worker finished an item and is about to take the next queued one, if any. */
  readonly onWorkerReady?: () => void;
}

export interface ReleaseSubmitOptions {
  /** Absolute monotonic deadline; defaults to submission time plus the item budget. */
  readonly deadline?: number;
  /** A close-time item: one attempt, not capped by the pending bound. */
  readonly closeTime?: boolean;
  /** Receives this submission's final outcome exactly once. */
  readonly onOutcome?: (outcome: ReleaseOutcome) => void;
}

interface ReleaseItem {
  readonly key: string;
  readonly request: LeaseSurrenderRequest;
  deadline: number;
  closeTime: boolean;
  readonly callbacks: Array<(outcome: ReleaseOutcome) => void>;
}

/** A FIFO with O(1) amortized push and shift: a head index over an array, compacted lazily. */
class Fifo<T> {
  #items: T[] = [];
  #head = 0;

  get length(): number {
    return this.#items.length - this.#head;
  }

  peek(): T | undefined {
    return this.#items[this.#head];
  }

  push(item: T): void {
    this.#items.push(item);
  }

  shift(): T | undefined {
    if (this.#head >= this.#items.length) return undefined;
    const item = this.#items[this.#head] as T;
    (this.#items as Array<T | undefined>)[this.#head] = undefined;
    this.#head += 1;
    if (this.#head === this.#items.length) {
      this.#items = [];
      this.#head = 0;
    } else if (this.#head >= 1_024 && this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }

  /** Removes and returns every item, oldest first. */
  takeAll(): T[] {
    const items = this.#head === 0 ? this.#items : this.#items.slice(this.#head);
    this.#items = [];
    this.#head = 0;
    return items;
  }
}

const SENT: ReleaseOutcome = Object.freeze({ kind: "sent" });

function dropped(reason: ReleaseDropReason): ReleaseOutcome {
  return Object.freeze({ kind: "dropped", reason });
}

function zeroDrops(): Record<ReleaseDropReason, number> {
  const drops = {} as Record<ReleaseDropReason, number>;
  for (const reason of RELEASE_DROP_REASONS) drops[reason] = 0;
  return drops;
}

function releaseKey(request: LeaseSurrenderRequest): string {
  return JSON.stringify([
    request.lease_id,
    request.holder_id,
    request.generation,
    request.spent_tokens ?? 0,
  ]);
}

export class ReleaseDispatcher {
  readonly #options: ReleaseDispatcherOptions;
  /** Queued and active items by merge key; only identical payloads merge. */
  readonly #items = new Map<string, ReleaseItem>();
  /** Ordinary items, oldest first. */
  readonly #queue = new Fifo<ReleaseItem>();
  /** Close-time items, oldest first; each has one attempt and is served before ordinary items. */
  readonly #closeQueue = new Fifo<ReleaseItem>();
  #active = 0;
  #peakActive = 0;
  #idleWaiters: Array<() => void> = [];
  #enqueued = 0;
  #merged = 0;
  #sent = 0;
  readonly #drops = zeroDrops();

  constructor(options: ReleaseDispatcherOptions) {
    this.#options = options;
  }

  /** Requests currently holding a worker slot. */
  get active(): number {
    return this.#active;
  }

  /** Items waiting for a worker. */
  get pending(): number {
    return this.#queue.length + this.#closeQueue.length;
  }

  /** Whether a submission now would start immediately instead of waiting. */
  get hasFreeWorker(): boolean {
    return this.pending === 0 && this.#active < RELEASE_WORKERS;
  }

  /** Highest observed number of simultaneously active requests. */
  get peakActive(): number {
    return this.#peakActive;
  }

  /** Diagnostic totals. `enqueued` equals `sent` plus every drop once the dispatcher is idle. */
  counts(): ReleaseCounts {
    return Object.freeze({
      enqueued: this.#enqueued,
      merged: this.#merged,
      sent: this.#sent,
      dropped: Object.freeze({ ...this.#drops }),
    });
  }

  /** Queue one surrender. Never waits and never scans the queue. */
  submit(request: LeaseSurrenderRequest, options: ReleaseSubmitOptions = {}): void {
    const now = this.#options.now();
    this.#expireQueued(now);
    const key = releaseKey(request);
    const existing = this.#items.get(key);
    if (existing !== undefined) {
      this.#merged += 1;
      if (options.onOutcome !== undefined) existing.callbacks.push(options.onOutcome);
      return;
    }
    this.#enqueued += 1;
    const closeTime = options.closeTime ?? false;
    const item: ReleaseItem = {
      key,
      request,
      deadline: options.deadline ?? now + this.#options.itemBudgetMs,
      closeTime,
      callbacks: options.onOutcome === undefined ? [] : [options.onOutcome],
    };
    if (item.deadline <= now) {
      this.#finish(item, dropped(closeTime ? "shutdown_deadline" : "expired"));
      return;
    }
    if (!closeTime && this.pending >= RELEASE_MAX_PENDING) {
      this.#finish(item, dropped("queue_full"));
      return;
    }
    this.#items.set(key, item);
    (closeTime ? this.#closeQueue : this.#queue).push(item);
    this.#pump();
  }

  /** Close fencing: queued items get one attempt within the close deadline. */
  clampForClose(deadline: number): void {
    for (const item of this.#closeQueue.takeAll()) this.#clampInto(item, deadline);
    for (const item of this.#queue.takeAll()) this.#clampInto(item, deadline);
  }

  #clampInto(item: ReleaseItem, deadline: number): void {
    item.deadline = Math.min(item.deadline, deadline);
    item.closeTime = true;
    this.#closeQueue.push(item);
  }

  /** Drop close-time items still waiting; returns how many were left. */
  dropCloseTimeQueued(): number {
    const left = this.#closeQueue.takeAll();
    for (const item of left) this.#finish(item, dropped("shutdown_deadline"));
    return left.length;
  }

  /** Resolves when no item is queued or active. */
  whenIdle(): Promise<void> {
    if (this.#active === 0 && this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  #pump(): void {
    while (this.#active < RELEASE_WORKERS) {
      const item = this.#next();
      if (item === null) return;
      this.#active += 1;
      this.#peakActive = Math.max(this.#peakActive, this.#active);
      try {
        void this.#work(item);
      } catch {
        this.#active -= 1;
        this.#finish(item, dropped("dispatch_failed"));
      }
    }
  }

  #next(): ReleaseItem | null {
    this.#expireQueued(this.#options.now());
    return this.#closeQueue.shift() ?? this.#queue.shift() ?? null;
  }

  /** Drops expired items from each FIFO's head; deadlines are non-decreasing within a FIFO. */
  #expireQueued(now: number): void {
    this.#expireHead(this.#closeQueue, now);
    this.#expireHead(this.#queue, now);
  }

  #expireHead(queue: Fifo<ReleaseItem>, now: number): void {
    for (let head = queue.peek(); head !== undefined && head.deadline <= now; head = queue.peek()) {
      queue.shift();
      this.#finish(head, dropped(head.closeTime ? "shutdown_deadline" : "expired"));
    }
  }

  async #work(first: ReleaseItem): Promise<void> {
    let item: ReleaseItem | null = first;
    try {
      while (item !== null) {
        let outcome: ReleaseOutcome;
        try {
          outcome = await this.#process(item);
        } catch {
          outcome = dropped("local_error");
        }
        this.#finish(item, outcome);
        try {
          this.#options.onWorkerReady?.();
        } catch {
          // Feeding more work is best effort; this worker still drains the queue.
        }
        item = this.#next();
      }
    } finally {
      this.#active -= 1;
      if (this.#active === 0 && this.pending === 0) {
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  async #process(item: ReleaseItem): Promise<ReleaseOutcome> {
    const attempts = item.closeTime ? 1 : Math.max(1, this.#options.maxAttempts);
    for (let attempt = 1; ; attempt += 1) {
      const remaining = item.deadline - this.#options.now();
      if (remaining <= 0) {
        if (attempt > 1) return dropped("timeout");
        return dropped(item.closeTime ? "shutdown_deadline" : "expired");
      }
      const { result, settled } = await this.#options.send(
        item.request,
        Math.min(this.#options.attemptTimeoutMs, remaining),
      );
      // The slot belongs to the request until the underlying fetch settles.
      if (settled !== null) await settled.then(noop, noop);
      if (result === "timeout" && attempt < attempts && !item.closeTime) continue;
      return result === "sent" ? SENT : dropped(result);
    }
  }

  #finish(item: ReleaseItem, outcome: ReleaseOutcome): void {
    if (this.#items.get(item.key) === item) this.#items.delete(item.key);
    if (outcome.kind === "sent") {
      this.#sent += 1;
    } else {
      this.#drops[outcome.reason] += 1;
      try {
        this.#options.onDrop?.(outcome.reason);
      } catch {
        // Diagnostics never change an item's outcome.
      }
    }
    for (const callback of item.callbacks.splice(0)) {
      try {
        callback(outcome);
      } catch {
        // An observer failure never strands another observer or the worker.
      }
    }
  }
}

function noop(): void {}
