import { describe, expect, it, vi } from "vitest";
import { noopLogger } from "../../src/logging";
import { VELOCITY_FLAGS, type VelocityFlag } from "../../src/types";
import {
  DENY_ELIGIBLE_RULE_ORDER,
  DENY_ELIGIBLE_RULES,
  type VelocityConfig,
  VelocityMonitor,
} from "../../src/velocity";

const BASE_CONFIG: VelocityConfig = Object.freeze({
  velocity_mode: "warn",
  velocity_repeat_count: 5,
  velocity_repeat_window_s: 60,
  velocity_growth_streak: 8,
  velocity_growth_factor: 3,
  velocity_accel_floor_per_min: 30,
  velocity_accel_factor: 3,
});

function seededRandom(seed = 42): () => number {
  return () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}

function monitor(
  overrides: Partial<VelocityConfig> = {},
  random = seededRandom(),
): VelocityMonitor {
  return new VelocityMonitor({ ...BASE_CONFIG, ...overrides }, noopLogger, random);
}

function observe(
  subject: VelocityMonitor,
  runId: string,
  estimatedInputTokens: number,
  now: number,
  model = "model-a",
): readonly VelocityFlag[] {
  return subject.observe({ runId, estimatedInputTokens, model, now });
}

describe("VelocityMonitor repeat detection", () => {
  it("defensively snapshots mutable construction input", () => {
    const config = { ...BASE_CONFIG, velocity_repeat_count: 2 };
    const subject = new VelocityMonitor(config);
    config.velocity_mode = "off";
    config.velocity_repeat_count = 64;

    observe(subject, "run", 100, 0);
    expect(observe(subject, "run", 100, 1)).toContain("repeat_size");
  });

  it("does not feed state in off mode", () => {
    const subject = monitor({ velocity_mode: "off", velocity_repeat_count: 2 });

    expect(observe(subject, "run", 100, 0)).toEqual([]);
    expect(observe(subject, "run", 100, 1)).toEqual([]);
    expect(subject.runCount()).toBe(0);
  });

  it("fires exactly at the configured same-model repeat threshold", () => {
    const subject = monitor({ velocity_repeat_count: 3 });

    expect(observe(subject, "run", 1_000, 0)).not.toContain("repeat_size");
    expect(observe(subject, "run", 1_010, 1)).not.toContain("repeat_size");
    expect(observe(subject, "run", 1_020, 2)).toContain("repeat_size");
  });

  it("isolates models and includes the exact repeat-window boundary", () => {
    const subject = monitor({ velocity_repeat_count: 2, velocity_repeat_window_s: 60 });

    observe(subject, "run", 100, 0, "model-a");
    expect(observe(subject, "run", 100, 60, "model-b")).not.toContain("repeat_size");
    expect(observe(subject, "run", 100, 60, "model-a")).toContain("repeat_size");

    const stale = monitor({ velocity_repeat_count: 2, velocity_repeat_window_s: 60 });
    observe(stale, "run", 100, 0);
    expect(observe(stale, "run", 100, 60.001)).not.toContain("repeat_size");
  });

  it("uses the eight-token tolerance floor and the two-percent branch inclusively", () => {
    const floor = monitor({ velocity_repeat_count: 2 });
    observe(floor, "run", 100, 0);
    expect(observe(floor, "run", 108, 1)).toContain("repeat_size");

    const outsideFloor = monitor({ velocity_repeat_count: 2 });
    observe(outsideFloor, "run", 100, 0);
    expect(observe(outsideFloor, "run", 109, 1)).not.toContain("repeat_size");

    const percentage = monitor({ velocity_repeat_count: 2 });
    observe(percentage, "run", 1_000, 0);
    expect(observe(percentage, "run", 1_020, 1)).toContain("repeat_size");

    const outsidePercentage = monitor({ velocity_repeat_count: 2 });
    observe(outsidePercentage, "run", 1_000, 0);
    expect(observe(outsidePercentage, "run", 1_021, 1)).not.toContain("repeat_size");
  });

  it("forgets a matching sample after more than sixty-four newer observations", () => {
    const subject = monitor({ velocity_repeat_count: 2, velocity_repeat_window_s: 1_000 });
    observe(subject, "run", 100, 0);
    for (let index = 0; index < 65; index += 1) {
      observe(subject, "run", 1_000, index + 1);
    }

    expect(observe(subject, "run", 100, 66)).not.toContain("repeat_size");
  });

  it("drops stale histories before displacing active runs at the 4096-run bound", () => {
    const subject = monitor({ velocity_repeat_count: 2 });
    for (let index = 0; index < 4096; index += 1) {
      observe(subject, `run-${index}`, 100, 0);
    }
    expect(subject.runCount()).toBe(4096);

    observe(subject, "run-0", 100, 211);
    observe(subject, "new-run", 100, 212);
    expect(subject.runCount()).toBe(2);
    expect(observe(subject, "run-0", 100, 213)).toContain("repeat_size");
  });

  it.each([129, 4097])("detects repeating calls across %i round-robin runs", (runCount) => {
    const subject = monitor({ velocity_mode: "deny" });
    let repeats = 0;
    for (let round = 0; round < 6; round += 1) {
      for (let index = 0; index < runCount; index += 1) {
        if (observe(subject, `run-${index}`, 100, round).includes("repeat_size")) {
          repeats += 1;
        }
      }
    }
    expect(repeats).toBeGreaterThanOrEqual(runCount - 2);
    expect(subject.runCount()).toBeLessThanOrEqual(4096);
  });

  it.each([
    ["warn", 50],
    ["warn", 100],
    ["deny", 50],
    ["deny", 100],
  ] as const)("detects new loops in %s mode among %i new runs per second", (mode, rate) => {
    const subject = monitor({ velocity_mode: mode });
    let firstRepeat: number | undefined;
    let firstGrowth: number | undefined;
    for (let second = 0; second < 120; second += 1) {
      for (let index = 0; index < rate; index += 1) {
        observe(subject, `short-${second}-${index}`, 100, second + index / rate);
      }
      if (second < 100) continue;
      // Both loops start only after one-call runs have filled the hard cap.
      if (second === 100) expect(subject.runCount()).toBe(4096);
      const now = second + 0.999;
      if (observe(subject, "repeat-loop", 500, now).includes("repeat_size")) {
        firstRepeat ??= second;
      }
      if (
        observe(subject, "growth-loop", 100 * 1.25 ** (second - 100), now).includes(
          "monotonic_growth",
        )
      ) {
        firstGrowth ??= second;
      }
    }

    expect(firstRepeat).toBe(104);
    expect(firstGrowth).toBe(107);
    expect(subject.runCount()).toBe(4096);
  });

  it("rate-limits warnings when the hard cap discards live history", () => {
    const warn = vi.fn();
    const subject = new VelocityMonitor(BASE_CONFIG, { ...noopLogger, warn });
    for (let index = 0; index < 4096; index += 1) {
      observe(subject, `run-${index}`, 100, 0);
    }
    expect(warn).not.toHaveBeenCalled();
    observe(subject, "overflow-a", 100, 1);
    observe(subject, "overflow-b", 100, 30.999);
    expect(warn).toHaveBeenCalledExactlyOnceWith("velocity.history_evicted");
    observe(subject, "overflow-c", 100, 31);
    expect(warn).toHaveBeenCalledTimes(2);
    observe(subject, "after-idle", 100, 300);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("clamps an injected RNG value of one when evicting live history", () => {
    const subject = monitor({ velocity_repeat_count: 2 }, () => 1);
    for (let index = 0; index < 4096; index++) {
      observe(subject, `run-${index}`, 100, 0);
    }
    expect(() => observe(subject, "overflow", 100, 1)).not.toThrow();
    expect(subject.runCount()).toBe(4096);
    expect(observe(subject, "run-0", 100, 2)).toContain("repeat_size");
    expect(observe(subject, "run-4095", 100, 2)).not.toContain("repeat_size");
    expect(subject.runCount()).toBe(4096);
  });

  it("retains history through the longest configured rule horizon", () => {
    const subject = monitor({ velocity_repeat_count: 2, velocity_repeat_window_s: 600 });
    observe(subject, "run", 100, 0);
    observe(subject, "other-run", 100, 500);
    expect(observe(subject, "run", 100, 600)).toContain("repeat_size");
  });
});

describe("VelocityMonitor monotonic-growth detection", () => {
  it("fires only when the exact streak is present, strictly increasing, and at factor equality", () => {
    const subject = monitor({ velocity_growth_streak: 4, velocity_growth_factor: 3 });

    expect(observe(subject, "run", 10, 0)).not.toContain("monotonic_growth");
    expect(observe(subject, "run", 15, 10)).not.toContain("monotonic_growth");
    expect(observe(subject, "run", 20, 30)).not.toContain("monotonic_growth");
    expect(observe(subject, "run", 30, 70)).toContain("monotonic_growth");

    const flat = monitor({ velocity_growth_streak: 4, velocity_growth_factor: 3 });
    for (const [size, now] of [
      [10, 0],
      [15, 1],
      [15, 2],
      [30, 3],
    ] as const) {
      expect(observe(flat, "run", size, now)).not.toContain("monotonic_growth");
    }
  });

  it("requires median inter-arrival gap to be strictly below thirty seconds", () => {
    const below = monitor({ velocity_growth_streak: 4, velocity_growth_factor: 3 });
    let belowFlags: readonly VelocityFlag[] = [];
    for (const [size, now] of [
      [10, 0],
      [15, 10],
      [20, 30],
      [30, 70],
    ] as const) {
      belowFlags = observe(below, "run", size, now);
    }
    expect(belowFlags).toContain("monotonic_growth");

    const equal = monitor({ velocity_growth_streak: 4, velocity_growth_factor: 3 });
    let equalFlags: readonly VelocityFlag[] = [];
    for (const [size, now] of [
      [10, 0],
      [15, 20],
      [20, 50],
      [30, 90],
    ] as const) {
      equalFlags = observe(equal, "run", size, now);
    }
    expect(equalFlags).not.toContain("monotonic_growth");
  });

  it("computes odd medians from the middle sorted gap", () => {
    const subject = monitor({ velocity_growth_streak: 5, velocity_growth_factor: 5 });
    let flags: readonly VelocityFlag[] = [];
    for (const [size, now] of [
      [1, 0],
      [2, 40],
      [3, 41],
      [4, 61],
      [5, 71],
    ] as const) {
      flags = observe(subject, "run", size, now);
    }
    expect(flags).toContain("monotonic_growth");
  });
});

describe("VelocityMonitor rate-acceleration detection", () => {
  it("uses inclusive sixty and one-twenty boundaries with zero-prior acceleration", () => {
    const sixty = monitor({ velocity_accel_floor_per_min: 2, velocity_accel_factor: 2 });
    observe(sixty, "run", 100, 60);
    expect(observe(sixty, "run", 100, 120)).toContain("rate_acceleration");

    const overSixty = monitor({ velocity_accel_floor_per_min: 1, velocity_accel_factor: 2 });
    observe(overSixty, "run", 100, 59.999);
    expect(observe(overSixty, "run", 100, 120)).not.toContain("rate_acceleration");

    const oneTwenty = monitor({ velocity_accel_floor_per_min: 1, velocity_accel_factor: 2 });
    observe(oneTwenty, "run", 100, 0);
    expect(observe(oneTwenty, "run", 100, 120)).not.toContain("rate_acceleration");

    const overOneTwenty = monitor({ velocity_accel_floor_per_min: 1, velocity_accel_factor: 2 });
    observe(overOneTwenty, "run", 100, -0.001);
    expect(observe(overOneTwenty, "run", 100, 120)).toContain("rate_acceleration");
  });

  it("enforces both the floor and acceleration factor", () => {
    const subject = monitor({ velocity_accel_floor_per_min: 3, velocity_accel_factor: 2 });
    observe(subject, "run", 100, 0);
    observe(subject, "run", 100, 70);
    expect(observe(subject, "run", 100, 120)).not.toContain("rate_acceleration");
    expect(observe(subject, "run", 100, 121)).toContain("rate_acceleration");
  });

  it("suppresses a rate flag when a live observation was dropped from full history", () => {
    const subject = monitor({ velocity_accel_floor_per_min: 1, velocity_accel_factor: 2 });
    for (let index = 0; index < 64; index += 1) {
      observe(subject, "run", 100, 50);
    }
    expect(observe(subject, "run", 100, 100)).not.toContain("rate_acceleration");
  });

  it("evaluates after a dropped observation is older than the rate horizon", () => {
    const subject = monitor({ velocity_accel_floor_per_min: 1, velocity_accel_factor: 2 });
    for (let index = 0; index < 64; index += 1) {
      observe(subject, "run", 100, 0);
    }
    expect(observe(subject, "run", 100, 120.001)).toContain("rate_acceleration");
  });

  it("suppresses a returning evicted run through its live tombstone deadline", () => {
    const subject = monitor(
      { velocity_accel_floor_per_min: 1, velocity_accel_factor: 2 },
      () => 1 - Number.EPSILON,
    );
    for (let index = 0; index < 4095; index += 1) {
      observe(subject, `seed-${index}`, 100, 0);
    }
    observe(subject, "victim", 100, 0);
    observe(subject, "churn", 100, 1);

    expect(observe(subject, "victim", 100, 120)).not.toContain("rate_acceleration");
    expect(observe(subject, "victim", 100, 120.001)).toContain("rate_acceleration");
  });

  it("fails closed on tombstone overflow and recovers strictly after the global deadline", () => {
    const subject = monitor({ velocity_accel_floor_per_min: 1, velocity_accel_factor: 2 });
    for (let index = 0; index < 4096; index += 1) {
      observe(subject, `seed-${index}`, 100, 0);
    }
    for (let index = 0; index < 257; index += 1) {
      observe(subject, `evict-${index}`, 100, 1);
    }

    expect(observe(subject, "never-seen-at-overflow", 100, 1)).not.toContain("rate_acceleration");
    expect(observe(subject, "never-seen-at-deadline", 100, 121)).not.toContain("rate_acceleration");
    expect(observe(subject, "never-seen-after-deadline", 100, 121.001)).toContain(
      "rate_acceleration",
    );
  });
});

describe("VelocityMonitor flag vocabulary and warning cadence", () => {
  it("emits all rules in wire order while keeping rate acceleration advisory", () => {
    const subject = monitor({
      velocity_repeat_count: 3,
      velocity_growth_streak: 3,
      velocity_growth_factor: 3,
      velocity_accel_floor_per_min: 1,
      velocity_accel_factor: 2,
    });

    observe(subject, "run", 1, 0);
    observe(subject, "run", 2, 1);
    const flags = observe(subject, "run", 3, 2);

    expect(flags).toEqual(["repeat_size", "monotonic_growth", "rate_acceleration"]);
    expect(flags.every((flag) => VELOCITY_FLAGS.includes(flag))).toBe(true);
    expect([...DENY_ELIGIBLE_RULES]).toEqual(["repeat_size", "monotonic_growth"]);
    expect(DENY_ELIGIBLE_RULE_ORDER).toEqual(["monotonic_growth", "repeat_size"]);
    expect(DENY_ELIGIBLE_RULES.has("rate_acceleration")).toBe(false);
  });

  it("warns first, suppresses before cooldown, and allows at exactly thirty seconds", () => {
    const subject = monitor();
    expect(subject.shouldWarn("run", "repeat_size", 10)).toBe(true);
    expect(subject.shouldWarn("run", "repeat_size", 39.999)).toBe(false);
    expect(subject.shouldWarn("run", "repeat_size", 40)).toBe(true);
  });

  it("tracks warning cadence independently by exact run and rule", () => {
    const subject = monitor();
    expect(subject.shouldWarn("run-a", "repeat_size", 0)).toBe(true);
    expect(subject.shouldWarn("run-a", "monotonic_growth", 1)).toBe(true);
    expect(subject.shouldWarn("run-b", "repeat_size", 1)).toBe(true);
    expect(subject.shouldWarn("run-a", "repeat_size", 1)).toBe(false);
  });

  it("fails closed on warning-key overflow and recovers at the exact deadline", () => {
    const subject = monitor();
    for (let index = 0; index < 256; index += 1) {
      expect(subject.shouldWarn(`run-${index}`, "repeat_size", 0)).toBe(true);
    }
    expect(subject.shouldWarn("overflow", "repeat_size", 0.25)).toBe(false);
    expect(subject.shouldWarn("at-deadline", "repeat_size", 30.25)).toBe(true);
    expect(subject.shouldWarn("after-deadline", "repeat_size", 30.251)).toBe(true);
  });
});
