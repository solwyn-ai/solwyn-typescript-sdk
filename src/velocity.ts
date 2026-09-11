import type { VelocityFlag } from "./types";

export const VELOCITY_HISTORY_LIMIT = 64;

const RUN_LIMIT = 128;
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

type StoredObservation = readonly [now: number, estimatedInputTokens: number, model: string];

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[middle] as number;
  }
  return ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2;
}

/** Pure, content-blind detector for structural per-run call velocity. */
export class VelocityMonitor {
  readonly #config: VelocityConfig;
  readonly #runs = new Map<string, StoredObservation[]>();
  readonly #rateTombstones = new Map<string, number>();
  readonly #warningTimes = new Map<string, number>();
  #rateOverflowSuppressThrough: number | undefined;
  #warningOverflowSuppressThrough: number | undefined;

  constructor(config: VelocityConfig) {
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
      if (this.#runs.size >= RUN_LIMIT) {
        const oldestRunId = this.#runs.keys().next().value as string;
        const evictedHistory = this.#runs.get(oldestRunId) as StoredObservation[];
        this.#runs.delete(oldestRunId);
        this.#rememberRateEviction(oldestRunId, evictedHistory, now);
      }
      history = [];
    } else {
      this.#runs.delete(runId);
    }
    this.#runs.set(runId, history);

    const droppedAt = history.length === VELOCITY_HISTORY_LIMIT ? history[0]?.[0] : undefined;
    if (history.length === VELOCITY_HISTORY_LIMIT) {
      history.shift();
    }
    history.push([now, estimatedInputTokens, model]);

    const tolerance = Math.max(8, 0.02 * estimatedInputTokens);
    let repeatMatches = 0;
    let currentMinuteCount = 0;
    let priorMinuteCount = 0;
    for (const [seenAt, seenSize, seenModel] of history) {
      const age = now - seenAt;
      if (age >= 0 && age <= 60) {
        currentMinuteCount += 1;
      } else if (age > 60 && age <= RATE_HORIZON_S) {
        priorMinuteCount += 1;
      }
      if (
        age >= 0 &&
        age <= this.#config.velocity_repeat_window_s &&
        seenModel === model &&
        Math.abs(seenSize - estimatedInputTokens) <= tolerance
      ) {
        repeatMatches += 1;
      }
    }

    const flags: VelocityFlag[] = [];
    if (repeatMatches >= this.#config.velocity_repeat_count) {
      flags.push("repeat_size");
    }

    const growth = history.slice(-this.#config.velocity_growth_streak);
    if (growth.length === this.#config.velocity_growth_streak) {
      const gaps: number[] = [];
      let strictlyIncreasing = true;
      for (let index = 1; index < growth.length; index += 1) {
        const previous = growth[index - 1] as StoredObservation;
        const current = growth[index] as StoredObservation;
        if (current[1] <= previous[1]) {
          strictlyIncreasing = false;
        }
        gaps.push(current[0] - previous[0]);
      }
      const first = growth[0] as StoredObservation;
      const latest = growth[growth.length - 1] as StoredObservation;
      if (
        strictlyIncreasing &&
        latest[1] >= this.#config.velocity_growth_factor * first[1] &&
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

  #rememberRateEviction(runId: string, history: readonly StoredObservation[], now: number): void {
    const lastObservation = history[history.length - 1];
    if (lastObservation === undefined) {
      return;
    }
    const deadline = lastObservation[0] + RATE_HORIZON_S;
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
