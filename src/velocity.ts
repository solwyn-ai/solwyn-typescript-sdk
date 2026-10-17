import { bestEffortLogger, type Logger, noopLogger } from "./logging";
import type { VelocityFlag } from "./types";

export const VELOCITY_HISTORY_LIMIT = 64;

const RUN_LIMIT = 4096;
const RATE_HORIZON_S = 120;
const WARNING_INTERVAL_S = 30;
const RATE_MEMORY_LIMIT = 256;
const WARNING_MEMORY_LIMIT = 256;
const EMPTY_FLAGS: readonly VelocityFlag[] = Object.freeze([]);

export const DENY_ELIGIBLE_RULES: ReadonlySet<VelocityFlag> = new Set([
  "repeat_size",
  "monotonic_growth",
]);

export const DENY_ELIGIBLE_RULE_ORDER = Object.freeze([
  "monotonic_growth",
  "repeat_size",
] as const satisfies readonly VelocityFlag[]);

export interface VelocityConfig {
  readonly velocity_mode: "off" | "warn" | "deny";
  readonly velocity_repeat_count: number;
  readonly velocity_repeat_window_s: number;
  readonly velocity_growth_streak: number;
  readonly velocity_growth_factor: number;
  readonly velocity_accel_floor_per_min: number;
  readonly velocity_accel_factor: number;
}

export interface VelocityObservation {
  readonly runId: string;
  readonly estimatedInputTokens: number;
  readonly model: string;
  readonly now: number;
}

/** Fixed-size ring: numeric samples do not allocate one object per observation. */
class RunHistory {
  readonly samples = new Float64Array(VELOCITY_HISTORY_LIMIT * 2);
  readonly models: string[] = [];
  length = 0;
  start = 0;

  constructor(public slot: number) {}

  time(index: number): number {
    return this.samples[((this.start + index) % VELOCITY_HISTORY_LIMIT) * 2] as number;
  }

  size(index: number): number {
    return this.samples[((this.start + index) % VELOCITY_HISTORY_LIMIT) * 2 + 1] as number;
  }

  model(index: number): string {
    return this.models[(this.start + index) % VELOCITY_HISTORY_LIMIT] as string;
  }

  push(now: number, size: number, model: string): number | undefined {
    const droppedAt = this.length === VELOCITY_HISTORY_LIMIT ? this.time(0) : undefined;
    const slot = (this.start + this.length) % VELOCITY_HISTORY_LIMIT;
    this.samples[slot * 2] = now;
    this.samples[slot * 2 + 1] = size;
    this.models[slot] = model;
    if (this.length === VELOCITY_HISTORY_LIMIT) {
      this.start = (this.start + 1) % VELOCITY_HISTORY_LIMIT;
    } else {
      this.length += 1;
    }
    return droppedAt;
  }
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[middle] as number;
  }
  return ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2;
}

/** Content-blind detector for structural per-run call velocity. */
export class VelocityMonitor {
  readonly #config: VelocityConfig;
  readonly #logger: Logger;
  readonly #historyHorizon: number;
  readonly #runs = new Map<string, RunHistory>();
  readonly #runIds: string[] = [];
  readonly #random: () => number;
  readonly #rateTombstones = new Map<string, number>();
  readonly #warningTimes = new Map<string, number>();
  #rateOverflowSuppressThrough: number | undefined;
  #warningOverflowSuppressThrough: number | undefined;
  #lastEvictionWarning: number | undefined;

  constructor(
    config: VelocityConfig,
    logger: Logger = noopLogger,
    random: () => number = Math.random,
  ) {
    this.#logger = bestEffortLogger(logger);
    this.#random = random;
    this.#historyHorizon = Math.max(
      config.velocity_repeat_window_s,
      30 * (config.velocity_growth_streak - 1),
      RATE_HORIZON_S,
    );
    this.#config = Object.freeze({
      velocity_mode: config.velocity_mode,
      velocity_repeat_count: config.velocity_repeat_count,
      velocity_repeat_window_s: config.velocity_repeat_window_s,
      velocity_growth_streak: config.velocity_growth_streak,
      velocity_growth_factor: config.velocity_growth_factor,
      velocity_accel_floor_per_min: config.velocity_accel_floor_per_min,
      velocity_accel_factor: config.velocity_accel_factor,
    });
  }

  observe(observation: VelocityObservation): readonly VelocityFlag[] {
    if (this.#config.velocity_mode === "off") {
      return EMPTY_FLAGS;
    }

    const { runId, estimatedInputTokens, model, now } = observation;
    if (
      this.#rateOverflowSuppressThrough !== undefined &&
      now > this.#rateOverflowSuppressThrough
    ) {
      this.#rateOverflowSuppressThrough = undefined;
    }

    let history = this.#runs.get(runId);
    if (history === undefined) {
      for (const [id, candidate] of this.#runs) {
        if (now - candidate.time(candidate.length - 1) <= this.#historyHorizon) break;
        this.#deleteHistory(id, candidate);
      }
      if (this.#runs.size >= RUN_LIMIT) {
        // Sample independently of observation order: oldest eviction cascades under
        // round-robin overflow, while newest eviction erases fresh loops amid churn.
        const evictedRunId = this.#runIds[
          Math.max(
            0,
            Math.min(this.#runIds.length - 1, Math.floor(this.#random() * this.#runIds.length)),
          )
        ] as string;
        const evictedHistory = this.#runs.get(evictedRunId) as RunHistory;
        this.#deleteHistory(evictedRunId, evictedHistory);
        this.#rememberRateEviction(evictedRunId, evictedHistory, now);
        if (
          this.#lastEvictionWarning === undefined ||
          now - this.#lastEvictionWarning >= WARNING_INTERVAL_S
        ) {
          this.#lastEvictionWarning = now;
          this.#logger.warn("velocity.history_evicted");
        }
      }
      history = new RunHistory(this.#runIds.length);
      this.#runIds.push(runId);
    } else {
      this.#runs.delete(runId);
      if (now - history.time(history.length - 1) > this.#historyHorizon) {
        history = new RunHistory(history.slot);
      }
    }
    this.#runs.set(runId, history);

    const droppedAt = history.push(now, estimatedInputTokens, model);

    const tolerance = Math.max(8, 0.02 * estimatedInputTokens);
    let repeatMatches = 0;
    let currentMinuteCount = 0;
    let priorMinuteCount = 0;
    for (let index = 0; index < history.length; index += 1) {
      const age = now - history.time(index);
      if (age >= 0 && age <= 60) {
        currentMinuteCount += 1;
      } else if (age > 60 && age <= RATE_HORIZON_S) {
        priorMinuteCount += 1;
      }
      if (
        age >= 0 &&
        age <= this.#config.velocity_repeat_window_s &&
        history.model(index) === model &&
        Math.abs(history.size(index) - estimatedInputTokens) <= tolerance
      ) {
        repeatMatches += 1;
      }
    }

    const flags: VelocityFlag[] = [];
    if (repeatMatches >= this.#config.velocity_repeat_count) {
      flags.push("repeat_size");
    }

    const growthStart = history.length - this.#config.velocity_growth_streak;
    if (growthStart >= 0) {
      const gaps: number[] = [];
      let strictlyIncreasing = true;
      for (let index = growthStart + 1; index < history.length; index += 1) {
        if (history.size(index) <= history.size(index - 1)) {
          strictlyIncreasing = false;
        }
        gaps.push(history.time(index) - history.time(index - 1));
      }
      if (
        strictlyIncreasing &&
        history.size(history.length - 1) >=
          this.#config.velocity_growth_factor * history.size(growthStart) &&
        median(gaps) < 30
      ) {
        flags.push("monotonic_growth");
      }
    }

    const rateWindowComplete =
      (droppedAt === undefined || now - droppedAt > RATE_HORIZON_S) &&
      !this.#hasLiveRateTombstone(runId, now) &&
      this.#rateOverflowSuppressThrough === undefined;
    if (
      rateWindowComplete &&
      currentMinuteCount >= this.#config.velocity_accel_floor_per_min &&
      currentMinuteCount >= this.#config.velocity_accel_factor * priorMinuteCount
    ) {
      flags.push("rate_acceleration");
    }

    return flags.length === 0 ? EMPTY_FLAGS : Object.freeze(flags);
  }

  shouldWarn(runId: string, rule: VelocityFlag, now: number): boolean {
    if (this.#warningOverflowSuppressThrough !== undefined) {
      if (now < this.#warningOverflowSuppressThrough) {
        return false;
      }
      this.#warningOverflowSuppressThrough = undefined;
    }

    const key = JSON.stringify([runId, rule]);
    const lastWarn = this.#warningTimes.get(key);
    if (lastWarn !== undefined) {
      this.#warningTimes.delete(key);
      this.#warningTimes.set(key, lastWarn);
      if (now - lastWarn < WARNING_INTERVAL_S) {
        return false;
      }
      this.#warningTimes.delete(key);
      this.#warningTimes.set(key, now);
      return true;
    }

    if (this.#warningTimes.size >= WARNING_MEMORY_LIMIT) {
      this.#warningTimes.clear();
      this.#warningOverflowSuppressThrough = now + WARNING_INTERVAL_S;
      return false;
    }
    this.#warningTimes.set(key, now);
    return true;
  }

  runCount(): number {
    return this.#runs.size;
  }

  #deleteHistory(runId: string, history: RunHistory): void {
    const lastRunId = this.#runIds.pop() as string;
    if (history.slot < this.#runIds.length) {
      this.#runIds[history.slot] = lastRunId;
      (this.#runs.get(lastRunId) as RunHistory).slot = history.slot;
    }
    this.#runs.delete(runId);
  }

  #hasLiveRateTombstone(runId: string, now: number): boolean {
    const deadline = this.#rateTombstones.get(runId);
    if (deadline === undefined) {
      return false;
    }
    this.#rateTombstones.delete(runId);
    if (now > deadline) {
      return false;
    }
    this.#rateTombstones.set(runId, deadline);
    return true;
  }

  #rememberRateEviction(runId: string, history: RunHistory, now: number): void {
    const deadline = history.time(history.length - 1) + RATE_HORIZON_S;
    if (now > deadline) {
      return;
    }

    this.#rateTombstones.delete(runId);
    if (this.#rateTombstones.size >= RATE_MEMORY_LIMIT) {
      this.#rateTombstones.clear();
      this.#rateOverflowSuppressThrough = Math.max(
        this.#rateOverflowSuppressThrough ?? Number.NEGATIVE_INFINITY,
        now + RATE_HORIZON_S,
        deadline,
      );
      return;
    }
    this.#rateTombstones.set(runId, deadline);
  }
}
