import { afterEach, describe, expect, it, vi } from "vitest";
import { SolwynCore, type SolwynOptions } from "../../src/client";
import {
  DEFAULT_API_URL,
  ENV_FIELD_MAP,
  FAILOVER_TUNING_DEFAULTS,
  getEnvSnapshot,
  loadConfigFromEnv,
  ON_UNMETERED_VALUES,
  pickFailoverTuning,
  pickVelocityConfig,
  resolveConfig,
  resolveConfigFromEnvSnapshot,
  type SolwynConfigOptions,
  SolwynConfigSchema,
  validateAcknowledgmentForContext,
  validateProviderChain,
} from "../../src/config";
import { ConfigurationError, SolwynError } from "../../src/errors";
import { DEFAULT_OUTPUT_BOUND } from "../../src/lease";
import { ProviderEntrySchema } from "../../src/validation";
import { VELOCITY_HISTORY_LIMIT } from "../../src/velocity";

// A well-formed project API key: `sk_proj_` + exactly 64 lowercase hex chars.
const VALID_KEY = `sk_proj_${"a".repeat(64)}`;

// A minimal, valid provider chain (non-empty) for tests that need a full config.
function providers(): SolwynConfigOptions["providers"] {
  return [{ provider: "openai", model: "gpt-4o" }];
}

function declaredOpenAIClient(): object {
  return { chat: { completions: { create: vi.fn() } } };
}

// Every test mutates process.env via vi.stubEnv; unstub after each so cases don't leak.
afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Environment-variable population and option precedence.
// ---------------------------------------------------------------------------

describe("env-var population", () => {
  it("defaults the untracked-surface posture and advisory settings", () => {
    const config = resolveConfig({ api_key: VALID_KEY, providers: providers() });

    expect(config.on_unmetered).toBe("warn");
    expect(config.acknowledge_untracked).toEqual([]);
    expect(Object.isFrozen(config.acknowledge_untracked)).toBe(true);
    expect(config.report_untracked_surfaces).toBe(true);
    expect(config.budget_check_timeout).toBe(1.0);
    expect(config.control_plane_failure_threshold).toBe(3);
    expect(config.control_plane_recovery_timeout).toBe(30.0);
    expect(config.breaker_reporting_enabled).toBe(true);
    expect(config.lease_enabled).toBe(true);
    expect(config.lease_output_bound_default).toBe(DEFAULT_OUTPUT_BOUND);
    expect(config.lease_output_bound_default).toBe(4096);
  });

  it("exposes the exact injected-snapshot map without SOLWYN_PROJECT_ID", () => {
    expect(ENV_FIELD_MAP).toEqual({
      api_key: "SOLWYN_API_KEY",
      api_url: "SOLWYN_API_URL",
      tags: "SOLWYN_TAGS",
      fail_open: "SOLWYN_FAIL_OPEN",
      budget_mode: "SOLWYN_BUDGET_MODE",
      budget_check_timeout: "SOLWYN_BUDGET_CHECK_TIMEOUT",
      control_plane_failure_threshold: "SOLWYN_CONTROL_PLANE_FAILURE_THRESHOLD",
      control_plane_recovery_timeout: "SOLWYN_CONTROL_PLANE_RECOVERY_TIMEOUT",
      breaker_reporting_enabled: "SOLWYN_BREAKER_REPORTING_ENABLED",
      lease_enabled: "SOLWYN_LEASE_ENABLED",
      lease_output_bound_default: "SOLWYN_LEASE_OUTPUT_BOUND_DEFAULT",
      circuit_breaker_failure_threshold: "SOLWYN_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
      circuit_breaker_recovery_timeout: "SOLWYN_CIRCUIT_BREAKER_RECOVERY_TIMEOUT",
      circuit_breaker_success_threshold: "SOLWYN_CIRCUIT_BREAKER_SUCCESS_THRESHOLD",
      budget_check_cache_ttl: "SOLWYN_BUDGET_CHECK_CACHE_TTL",
      reporter_batch_size: "SOLWYN_REPORTER_BATCH_SIZE",
      reporter_flush_interval: "SOLWYN_REPORTER_FLUSH_INTERVAL",
      reporter_max_queue_size: "SOLWYN_REPORTER_MAX_QUEUE_SIZE",
      reporter_max_in_flight: "SOLWYN_REPORTER_MAX_IN_FLIGHT",
      reporter_max_send_attempts: "SOLWYN_REPORTER_MAX_SEND_ATTEMPTS",
      reporter_retry_backoff_base: "SOLWYN_REPORTER_RETRY_BACKOFF_BASE",
      reporter_retry_backoff_cap: "SOLWYN_REPORTER_RETRY_BACKOFF_CAP",
      reporter_shutdown_deadline: "SOLWYN_REPORTER_SHUTDOWN_DEADLINE",
      breaker_report_heartbeat: "SOLWYN_BREAKER_REPORT_HEARTBEAT",
      on_unmetered: "SOLWYN_ON_UNMETERED",
      acknowledge_untracked: "SOLWYN_ACKNOWLEDGE_UNTRACKED",
      report_untracked_surfaces: "SOLWYN_REPORT_UNTRACKED_SURFACES",
      velocity_mode: "SOLWYN_VELOCITY_MODE",
      velocity_repeat_count: "SOLWYN_VELOCITY_REPEAT_COUNT",
      velocity_repeat_window_s: "SOLWYN_VELOCITY_REPEAT_WINDOW_S",
      velocity_growth_streak: "SOLWYN_VELOCITY_GROWTH_STREAK",
      velocity_growth_factor: "SOLWYN_VELOCITY_GROWTH_FACTOR",
      velocity_accel_floor_per_min: "SOLWYN_VELOCITY_ACCEL_FLOOR_PER_MIN",
      velocity_accel_factor: "SOLWYN_VELOCITY_ACCEL_FACTOR",
    });
    expect(Object.isFrozen(getEnvSnapshot())).toBe(true);
  });

  it("resolves only from an explicit snapshot when one is injected", () => {
    const snapshot = {
      SOLWYN_API_URL: "https://snapshot.invalid",
      SOLWYN_FAIL_OPEN: "false",
      SOLWYN_BUDGET_CHECK_CACHE_TTL: "23",
    } as const;
    expect(loadConfigFromEnv({ api_key: VALID_KEY }, snapshot)).toMatchObject({
      api_key: VALID_KEY,
      api_url: "https://snapshot.invalid",
      fail_open: false,
      budget_check_cache_ttl: "23",
    });
    expect(resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, snapshot)).toMatchObject({
      api_url: "https://snapshot.invalid",
      fail_open: false,
      budget_check_cache_ttl: 23,
    });
  });

  it("SOLWYN_API_KEY alone populates api_key (no api_key kwarg required)", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    const config = resolveConfig({ providers: providers() });
    expect(config.api_key).toBe(VALID_KEY);
  });

  it("SOLWYN_API_URL overrides the default endpoint", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_API_URL", "https://api.example.test");
    const config = resolveConfig({ providers: providers() });
    expect(config.api_url).toBe("https://api.example.test");
  });

  it("defaults api_url to https://api.solwyn.ai when unset", () => {
    const config = resolveConfig({ api_key: VALID_KEY, providers: providers() });
    expect(config.api_url).toBe(DEFAULT_API_URL);
    expect(DEFAULT_API_URL).toBe("https://api.solwyn.ai");
  });

  it('SOLWYN_BUDGET_MODE="hard_deny" resolves to the hard_deny mode', () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_BUDGET_MODE", "hard_deny");
    const config = resolveConfig({ providers: providers() });
    expect(config.budget_mode).toBe("hard_deny");
  });

  it("coerces numeric env strings for the mapped int/float fields", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_CIRCUIT_BREAKER_FAILURE_THRESHOLD", "7");
    vi.stubEnv("SOLWYN_REPORTER_FLUSH_INTERVAL", "2.5");
    vi.stubEnv("SOLWYN_BUDGET_CHECK_CACHE_TTL", "11");
    vi.stubEnv("SOLWYN_BUDGET_CHECK_TIMEOUT", "0.75");
    vi.stubEnv("SOLWYN_CONTROL_PLANE_FAILURE_THRESHOLD", "9");
    vi.stubEnv("SOLWYN_CONTROL_PLANE_RECOVERY_TIMEOUT", "12.5");
    vi.stubEnv("SOLWYN_BREAKER_REPORTING_ENABLED", "no");
    const config = resolveConfig({ providers: providers() });
    expect(config.circuit_breaker_failure_threshold).toBe(7);
    expect(config.reporter_flush_interval).toBe(2.5);
    expect(config.budget_check_cache_ttl).toBe(11);
    expect(config.budget_check_timeout).toBe(0.75);
    expect(config.control_plane_failure_threshold).toBe(9);
    expect(config.control_plane_recovery_timeout).toBe(12.5);
    expect(config.breaker_reporting_enabled).toBe(false);
  });

  it("kwargs override a conflicting env var of the same field", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_API_URL", "https://from-env.test");
    vi.stubEnv("SOLWYN_BUDGET_MODE", "alert_only");
    const config = resolveConfig({
      api_url: "https://from-kwarg.test",
      budget_mode: "hard_deny",
      providers: providers(),
    });
    expect(config.api_url).toBe("https://from-kwarg.test");
    expect(config.budget_mode).toBe("hard_deny");
  });
});

describe("velocity configuration", () => {
  it("resolves all seven defaults and produces a defensive frozen snapshot", () => {
    const resolved = resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, {});
    expect(resolved).toMatchObject({
      velocity_mode: "warn",
      velocity_repeat_count: 5,
      velocity_repeat_window_s: 60,
      velocity_growth_streak: 8,
      velocity_growth_factor: 3,
      velocity_accel_floor_per_min: 30,
      velocity_accel_factor: 3,
    });

    const mutable = {
      velocity_mode: "deny" as const,
      velocity_repeat_count: 2,
      velocity_repeat_window_s: 12.5,
      velocity_growth_streak: 3,
      velocity_growth_factor: 2,
      velocity_accel_floor_per_min: 4,
      velocity_accel_factor: 2.5,
    };
    const snapshot = pickVelocityConfig(mutable);
    mutable.velocity_repeat_count = 64;
    expect(snapshot).toEqual({
      velocity_mode: "deny",
      velocity_repeat_count: 2,
      velocity_repeat_window_s: 12.5,
      velocity_growth_streak: 3,
      velocity_growth_factor: 2,
      velocity_accel_floor_per_min: 4,
      velocity_accel_factor: 2.5,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("coerces numeric env values and lets explicit options win field by field", () => {
    const resolved = resolveConfigFromEnvSnapshot(
      {
        api_key: VALID_KEY,
        velocity_mode: "deny",
        velocity_repeat_count: 7,
        velocity_growth_factor: 4,
      },
      {
        SOLWYN_VELOCITY_MODE: "off",
        SOLWYN_VELOCITY_REPEAT_COUNT: "9",
        SOLWYN_VELOCITY_REPEAT_WINDOW_S: "12.5",
        SOLWYN_VELOCITY_GROWTH_STREAK: "6",
        SOLWYN_VELOCITY_GROWTH_FACTOR: "5.5",
        SOLWYN_VELOCITY_ACCEL_FLOOR_PER_MIN: "11",
        SOLWYN_VELOCITY_ACCEL_FACTOR: "2.25",
      },
    );
    expect(resolved).toMatchObject({
      velocity_mode: "deny",
      velocity_repeat_count: 7,
      velocity_repeat_window_s: 12.5,
      velocity_growth_streak: 6,
      velocity_growth_factor: 4,
      velocity_accel_floor_per_min: 11,
      velocity_accel_factor: 2.25,
    });
  });

  it("accepts positive Infinity for every constructor-sourced velocity float", () => {
    const resolved = resolveConfigFromEnvSnapshot(
      {
        api_key: VALID_KEY,
        velocity_repeat_window_s: Number.POSITIVE_INFINITY,
        velocity_growth_factor: Number.POSITIVE_INFINITY,
        velocity_accel_factor: Number.POSITIVE_INFINITY,
      },
      {},
    );

    expect(resolved).toMatchObject({
      velocity_repeat_window_s: Number.POSITIVE_INFINITY,
      velocity_growth_factor: Number.POSITIVE_INFINITY,
      velocity_accel_factor: Number.POSITIVE_INFINITY,
    });
  });

  it("accepts positive Infinity through the public camel-case constructor options", async () => {
    let core: SolwynCore | undefined;
    try {
      core = new SolwynCore(declaredOpenAIClient(), {
        apiKey: VALID_KEY,
        velocityRepeatWindowS: Number.POSITIVE_INFINITY,
        velocityGrowthFactor: Number.POSITIVE_INFINITY,
        velocityAccelFactor: Number.POSITIVE_INFINITY,
      });
      expect(core).toBeInstanceOf(SolwynCore);
    } finally {
      await core?.close();
    }
  });

  it.each([
    ["SOLWYN_VELOCITY_REPEAT_WINDOW_S", "inf", "velocity_repeat_window_s"],
    ["SOLWYN_VELOCITY_GROWTH_FACTOR", "Infinity", "velocity_growth_factor"],
    ["SOLWYN_VELOCITY_ACCEL_FACTOR", "+inf", "velocity_accel_factor"],
  ] as const)("coerces the Pydantic infinity spelling %s=%s", (envName, raw, field) => {
    const resolved = resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { [envName]: raw });

    expect(resolved[field]).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ["SOLWYN_VELOCITY_REPEAT_WINDOW_S", "velocity_repeat_window_s"],
    ["SOLWYN_VELOCITY_GROWTH_FACTOR", "velocity_growth_factor"],
    ["SOLWYN_VELOCITY_ACCEL_FACTOR", "velocity_accel_factor"],
  ] as const)("accepts decimal overflow from %s", (envName, field) => {
    const resolved = resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { [envName]: "1e9999" });

    expect(resolved[field]).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    [
      "hexadecimal",
      "SOLWYN_VELOCITY_REPEAT_WINDOW_S",
      "velocity_repeat_window_s",
      `0x${"f".repeat(512)}`,
    ],
    ["binary", "SOLWYN_VELOCITY_GROWTH_FACTOR", "velocity_growth_factor", `0b${"1".repeat(2048)}`],
    ["octal", "SOLWYN_VELOCITY_ACCEL_FACTOR", "velocity_accel_factor", `0o${"7".repeat(1024)}`],
  ] as const)("rejects overflowing JavaScript-only %s env input", (_kind, envName, field, raw) => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { [envName]: raw });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it.each([
    ["SOLWYN_VELOCITY_REPEAT_WINDOW_S", "-inf", "velocity_repeat_window_s"],
    ["SOLWYN_VELOCITY_GROWTH_FACTOR", "-Infinity", "velocity_growth_factor"],
    ["SOLWYN_VELOCITY_ACCEL_FACTOR", "NaN", "velocity_accel_factor"],
    ["SOLWYN_VELOCITY_REPEAT_WINDOW_S", "", "velocity_repeat_window_s"],
    ["SOLWYN_VELOCITY_GROWTH_FACTOR", "", "velocity_growth_factor"],
    ["SOLWYN_VELOCITY_ACCEL_FACTOR", "", "velocity_accel_factor"],
  ] as const)("rejects invalid velocity float env input %s=%s", (envName, raw, field) => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { [envName]: raw });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it.each([
    ["velocity_mode", "block"],
    ["velocity_repeat_count", 1],
    ["velocity_repeat_count", 65],
    ["velocity_repeat_count", 2.5],
    ["velocity_repeat_window_s", 0],
    ["velocity_growth_streak", 2],
    ["velocity_growth_streak", 65],
    ["velocity_growth_factor", 1],
    ["velocity_accel_floor_per_min", 0],
    ["velocity_accel_floor_per_min", 65],
    ["velocity_accel_factor", 1],
  ] as const)("attributes invalid %s=%s to the typed configuration field", (field, value) => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot(
        { api_key: VALID_KEY, [field]: value } as unknown as SolwynConfigOptions,
        {},
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it.each([
    ["velocity_repeat_window_s", Number.NEGATIVE_INFINITY],
    ["velocity_repeat_window_s", Number.NaN],
    ["velocity_growth_factor", Number.NEGATIVE_INFINITY],
    ["velocity_growth_factor", Number.NaN],
    ["velocity_accel_factor", Number.NEGATIVE_INFINITY],
    ["velocity_accel_factor", Number.NaN],
  ] as const)("rejects non-positive non-finite %s=%s with field attribution", (field, value) => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot(
        { api_key: VALID_KEY, [field]: value } as unknown as SolwynConfigOptions,
        {},
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it.each([
    ["velocity_repeat_count", Number.POSITIVE_INFINITY],
    ["velocity_growth_streak", Number.POSITIVE_INFINITY],
    ["velocity_accel_floor_per_min", Number.POSITIVE_INFINITY],
  ] as const)("rejects positive Infinity for bounded integer %s", (field, value) => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot(
        { api_key: VALID_KEY, [field]: value } as unknown as SolwynConfigOptions,
        {},
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it.each([
    ["velocity_repeat_count", "65"],
    ["velocity_growth_streak", "65"],
    ["velocity_accel_floor_per_min", "65"],
  ] as const)("enforces the history-derived upper bound for env field %s", (field, value) => {
    const envName = ENV_FIELD_MAP[field] as string;
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { [envName]: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it("accepts the exact shared history limit for every bounded threshold", () => {
    expect(VELOCITY_HISTORY_LIMIT).toBe(64);
    expect(
      resolveConfigFromEnvSnapshot(
        { api_key: VALID_KEY },
        {
          SOLWYN_VELOCITY_REPEAT_COUNT: "64",
          SOLWYN_VELOCITY_GROWTH_STREAK: "64",
          SOLWYN_VELOCITY_ACCEL_FLOOR_PER_MIN: "64",
        },
      ),
    ).toMatchObject({
      velocity_repeat_count: 64,
      velocity_growth_streak: 64,
      velocity_accel_floor_per_min: 64,
    });
  });

  it.each([
    ["velocityMode", "block", "velocity_mode"],
    ["velocityRepeatCount", 65, "velocity_repeat_count"],
    ["velocityRepeatWindowS", 0, "velocity_repeat_window_s"],
    ["velocityGrowthStreak", 65, "velocity_growth_streak"],
    ["velocityGrowthFactor", 1, "velocity_growth_factor"],
    ["velocityAccelFloorPerMin", 0, "velocity_accel_floor_per_min"],
    ["velocityAccelFactor", 1, "velocity_accel_factor"],
  ] as const)("maps camel-case constructor option %s to %s", (option, value, field) => {
    let caught: unknown;
    try {
      new SolwynCore({}, { apiKey: VALID_KEY, [option]: value } as unknown as SolwynOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it("accepts the exact shared history limit through camel-case constructor options", async () => {
    let core: SolwynCore | undefined;
    try {
      core = new SolwynCore(declaredOpenAIClient(), {
        apiKey: VALID_KEY,
        velocityRepeatCount: 64,
        velocityGrowthStreak: 64,
        velocityAccelFloorPerMin: 64,
      });
      expect(core).toBeInstanceOf(SolwynCore);
    } finally {
      await core?.close();
    }
  });
});

describe("untracked-surface environment settings", () => {
  it("exports the closed posture vocabulary in authored order", () => {
    expect(ON_UNMETERED_VALUES).toEqual(["warn", "raise", "allow"]);
  });

  it("parses, trims, and first-order deduplicates env acknowledgments", () => {
    const config = resolveConfigFromEnvSnapshot(
      { api_key: VALID_KEY },
      {
        SOLWYN_ON_UNMETERED: "raise",
        SOLWYN_ACKNOWLEDGE_UNTRACKED: " responses.retrieve, future.operation ,responses.retrieve ",
        SOLWYN_REPORT_UNTRACKED_SURFACES: "false",
      },
    );

    expect(config.on_unmetered).toBe("raise");
    expect(config.acknowledge_untracked).toEqual(["responses.retrieve", "future.operation"]);
    expect(Object.isFrozen(config.acknowledge_untracked)).toBe(true);
    expect(config.report_untracked_surfaces).toBe(false);
  });

  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["TRUE", true],
    ["Yes", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["anything-else", false],
  ])("coerces SOLWYN_REPORT_UNTRACKED_SURFACES=%s to %s", (raw, expected) => {
    const config = resolveConfigFromEnvSnapshot(
      { api_key: VALID_KEY },
      { SOLWYN_REPORT_UNTRACKED_SURFACES: raw },
    );
    expect(config.report_untracked_surfaces).toBe(expected);
  });

  it("keeps posture exact and untrimmed", () => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { SOLWYN_ON_UNMETERED: " warn" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("on_unmetered");
  });

  it("preserves D3 constructor precedence for all three settings", () => {
    const config = resolveConfigFromEnvSnapshot(
      {
        api_key: VALID_KEY,
        on_unmetered: "allow",
        acknowledge_untracked: ["future.constructor"],
        report_untracked_surfaces: false,
      },
      {
        SOLWYN_ON_UNMETERED: "raise",
        SOLWYN_ACKNOWLEDGE_UNTRACKED: "future.environment",
        SOLWYN_REPORT_UNTRACKED_SURFACES: "true",
      },
    );

    expect(config.on_unmetered).toBe("allow");
    expect(config.acknowledge_untracked).toEqual(["future.constructor"]);
    expect(config.report_untracked_surfaces).toBe(false);
  });
});

describe("acknowledge_untracked validation", () => {
  it.each([
    [
      "plain string",
      "responses.retrieve",
      "acknowledge_untracked must be a collection of exact tokens",
    ],
    [
      "malformed token",
      [" private.operation"],
      "acknowledge_untracked tokens must be exact wire-eligible public dotted paths",
    ],
    [
      "known non-acknowledgeable token",
      ["responses"],
      "acknowledge_untracked token names a resource container",
    ],
  ])("enforces the content-blind %s invariant in SolwynConfigSchema", (_label, value, message) => {
    const result = SolwynConfigSchema.safeParse({
      api_key: VALID_KEY,
      acknowledge_untracked: value,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ["acknowledge_untracked"],
        message,
      });
    }
  });

  it("deduplicates and freezes valid acknowledgments through SolwynConfigSchema directly", () => {
    const input = ["responses.retrieve", "future.operation", "responses.retrieve"];
    const parsed = SolwynConfigSchema.parse({
      api_key: VALID_KEY,
      acknowledge_untracked: input,
    });
    input[0] = "mutated.after.parse";

    expect(parsed.acknowledge_untracked).toEqual(["responses.retrieve", "future.operation"]);
    expect(Object.isFrozen(parsed.acknowledge_untracked)).toBe(true);
  });

  it("snapshots a stateful acknowledgment iterator exactly once before validation", () => {
    let traversals = 0;
    const tokens: string[] = [];
    Object.defineProperty(tokens, Symbol.iterator, {
      configurable: true,
      value() {
        traversals += 1;
        const sequence =
          traversals === 1
            ? ["future.operation", "responses.retrieve", "future.operation"]
            : ["PRIVATE_PROMPT\nCONTENT"];
        return sequence[Symbol.iterator]();
      },
    });

    const config = resolveConfig({ api_key: VALID_KEY, acknowledge_untracked: tokens });

    expect(traversals).toBe(1);
    expect(config.acknowledge_untracked).toEqual(["future.operation", "responses.retrieve"]);
    expect(config.acknowledge_untracked).not.toContain("PRIVATE_PROMPT\nCONTENT");
    expect(Object.isFrozen(config.acknowledge_untracked)).toBe(true);
  });

  it.each([
    [
      "throwing iterator getter",
      () => {
        const tokens: string[] = [];
        Object.defineProperty(tokens, Symbol.iterator, {
          get() {
            throw new Error("PRIVATE_ITERATOR_GETTER_CONTENT");
          },
        });
        return tokens;
      },
      "acknowledge_untracked tokens must be exact wire-eligible public dotted paths",
    ],
    [
      "throwing iterator",
      () => {
        const tokens: string[] = [];
        tokens[Symbol.iterator] = () => {
          throw new Error("PRIVATE_ITERATOR_CONTENT");
        };
        return tokens;
      },
      "acknowledge_untracked tokens must be exact wire-eligible public dotted paths",
    ],
    [
      "revoked array proxy",
      () => {
        const revocable = Proxy.revocable<string[]>([], {});
        revocable.revoke();
        return revocable.proxy;
      },
      "acknowledge_untracked must be a collection of exact tokens",
    ],
  ])("normalizes a %s failure to a data-free field error", (_label, buildTokens, message) => {
    let caught: unknown;
    try {
      resolveConfig({ api_key: VALID_KEY, acknowledge_untracked: buildTokens() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("acknowledge_untracked");
    expect((caught as Error).message).toBe(message);
    expect((caught as Error).message).not.toContain("PRIVATE_");
  });

  it("rejects a constructor string with the exact collection error", () => {
    let caught: unknown;
    try {
      resolveConfig({
        api_key: VALID_KEY,
        acknowledge_untracked: "responses.retrieve",
      } as unknown as SolwynConfigOptions);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("acknowledge_untracked");
    expect((caught as Error).message).toBe(
      "acknowledge_untracked must be a collection of exact tokens",
    );
  });

  it.each([
    "",
    ",responses.retrieve",
    "responses.retrieve,",
    "responses.retrieve,,future.op",
  ])("rejects an empty env segment in %j with the exact error", (raw) => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { SOLWYN_ACKNOWLEDGE_UNTRACKED: raw });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("acknowledge_untracked");
    expect((caught as Error).message).toBe(
      "SOLWYN_ACKNOWLEDGE_UNTRACKED must not contain empty elements",
    );
  });

  it("copies, first-order deduplicates, and freezes constructor arrays", () => {
    const tokens = ["future.operation", "responses.retrieve", "future.operation"];
    const config = resolveConfig({ api_key: VALID_KEY, acknowledge_untracked: tokens });
    tokens[0] = "changed.after.resolution";
    tokens.push("later.mutation");

    expect(config.acknowledge_untracked).toEqual(["future.operation", "responses.retrieve"]);
    expect(Object.isFrozen(config.acknowledge_untracked)).toBe(true);
  });

  it.each([
    " responses.retrieve",
    "responses.retrieve ",
    "_private.operation",
    "not..exact",
    "audio.speech.create:another-model",
  ])("rejects malformed constructor token %j without reflecting it", (token) => {
    let caught: unknown;
    try {
      resolveConfig({ api_key: VALID_KEY, acknowledge_untracked: [token] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("acknowledge_untracked");
    expect((caught as Error).message).toBe(
      "acknowledge_untracked tokens must be exact wire-eligible public dotted paths",
    );
    expect((caught as Error).message).not.toContain(token);
  });

  it("keeps an invalid element error on the field rather than an array index", () => {
    let caught: unknown;
    try {
      resolveConfig({
        api_key: VALID_KEY,
        acknowledge_untracked: [17],
      } as unknown as SolwynConfigOptions);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("acknowledge_untracked");
    expect((caught as Error).message).toBe(
      "acknowledge_untracked tokens must be exact wire-eligible public dotted paths",
    );
  });

  it.each([
    "responses.create",
    "responses.parse",
    "responses.stream",
    "responses.retrieve",
    "audio.speech.create:gpt-4o-mini-tts",
    "beta.skills.versions.download",
    "future.operation",
  ])("accepts acknowledgeable or provisional exact token %s", (token) => {
    expect(
      resolveConfig({ api_key: VALID_KEY, acknowledge_untracked: [token] }).acknowledge_untracked,
    ).toEqual([token]);
  });

  it.each([
    ["responses", "acknowledge_untracked token names a resource container"],
    [
      "chat.completions.create",
      "acknowledge_untracked token names a known non-acknowledgeable surface",
    ],
    [
      "audio.speech.create",
      "acknowledge_untracked token names a known non-acknowledgeable surface",
    ],
  ])("rejects known non-acknowledgeable token %s without reflecting it", (token, message) => {
    let caught: unknown;
    try {
      resolveConfig({ api_key: VALID_KEY, acknowledge_untracked: [token] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("acknowledge_untracked");
    expect((caught as Error).message).toBe(message);
    expect((caught as Error).message).not.toContain(token);
  });
});

describe("context-aware acknowledgment validation", () => {
  it.each([
    ["openai", "responses.create"],
    ["openai", "responses.parse"],
    ["openai", "responses.stream"],
    ["azure_openai", "responses.create"],
    ["azure_openai", "responses.parse"],
    ["azure_openai", "responses.stream"],
  ] as const)("rejects tracked native %s token %s", (provider, token) => {
    let caught: unknown;
    try {
      validateAcknowledgmentForContext(token, {
        provider,
        dialect: "openai",
        clientShape: "openai_sdk",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("acknowledge_untracked");
    expect((caught as Error).message).toBe(
      "acknowledge_untracked token names a known non-acknowledgeable surface",
    );
    expect((caught as Error).message).not.toContain(provider);
    expect((caught as Error).message).not.toContain(token);
  });

  it.each([
    { provider: "groq", dialect: "openai", clientShape: "openai_sdk" },
    { provider: "together", dialect: "openai", clientShape: "openai_sdk" },
  ] as const)("accepts generic-compatible Responses for $provider", (context) => {
    expect(validateAcknowledgmentForContext("responses.create", context)).toBeUndefined();
    expect(validateAcknowledgmentForContext("responses.parse", context)).toBeUndefined();
    expect(validateAcknowledgmentForContext("responses.stream", context)).toBeUndefined();
  });

  it("accepts the special TTS token only in native OpenAI/Azure contexts", () => {
    const token = "audio.speech.create:gpt-4o-mini-tts";
    expect(
      validateAcknowledgmentForContext(token, {
        provider: "openai",
        dialect: "openai",
        clientShape: "openai_sdk",
      }),
    ).toBeUndefined();
    expect(
      validateAcknowledgmentForContext(token, {
        provider: "azure_openai",
        dialect: "openai",
        clientShape: "openai_sdk",
      }),
    ).toBeUndefined();
    expect(() =>
      validateAcknowledgmentForContext(token, {
        provider: "groq",
        dialect: "openai",
        clientShape: "openai_sdk",
      }),
    ).toThrowError("acknowledge_untracked token names a known non-acknowledgeable surface");
  });

  it("accepts an absent ordinary token provisionally but rejects an applicable known row", () => {
    const context = {
      provider: "anthropic",
      dialect: "anthropic",
      clientShape: "anthropic_sdk",
    } as const;

    expect(validateAcknowledgmentForContext("future.operation", context)).toBeUndefined();
    expect(() => validateAcknowledgmentForContext("chat.completions.create", context)).toThrowError(
      "acknowledge_untracked token names a known non-acknowledgeable surface",
    );
  });

  it("accepts the verified beta skills download acknowledgment in an Anthropic context", () => {
    const context = {
      provider: "anthropic",
      dialect: "anthropic",
      clientShape: "anthropic_sdk",
    } as const;

    expect(
      validateAcknowledgmentForContext("beta.skills.versions.download", context),
    ).toBeUndefined();
  });

  it("re-runs syntax and context-independent safety for direct callers", () => {
    expect(() =>
      validateAcknowledgmentForContext(" private.operation", {
        provider: "openai",
        dialect: "openai",
        clientShape: "openai_sdk",
      }),
    ).toThrowError("acknowledge_untracked tokens must be exact wire-eligible public dotted paths");
    expect(() =>
      validateAcknowledgmentForContext("responses", {
        provider: "groq",
        dialect: "openai",
        clientShape: "openai_sdk",
      }),
    ).toThrowError("acknowledge_untracked token names a resource container");
  });
});

describe("tags configuration", () => {
  it("accepts explicit tags, empty values, and Unicode code-point inclusive bounds", () => {
    const key = "🦊".repeat(64);
    const value = "🌲".repeat(256);
    expect(resolveConfig({ api_key: VALID_KEY, tags: { [key]: value, empty: "" } }).tags).toEqual({
      [key]: value,
      empty: "",
    });
  });

  it("parses SOLWYN_TAGS at the first equals and preserves whitespace and empty values", () => {
    const config = resolveConfigFromEnvSnapshot(
      { api_key: VALID_KEY },
      { SOLWYN_TAGS: "a=b=c, spaced key = spaced value ,empty=" },
    );
    expect(config.tags).toEqual({
      a: "b=c",
      " spaced key ": " spaced value ",
      empty: "",
    });
  });

  it.each([
    "missing-equals",
    "a=b,",
    ",a=b",
    "a=b,,c=d",
  ])("rejects malformed SOLWYN_TAGS %j with the exact parse message", (tags) => {
    let caught: unknown;
    try {
      resolveConfigFromEnvSnapshot({ api_key: VALID_KEY }, { SOLWYN_TAGS: tags });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("tags");
    expect((caught as Error).message).toBe("SOLWYN_TAGS entries must use key=value");
  });

  it.each([
    ["plain constructor string", "a=b"],
    ["NUL key", { "bad\0key": "value" }],
    ["NUL value", { key: "bad\0value" }],
    ["oversized key", { ["🦊".repeat(65)]: "value" }],
    ["oversized value", { key: "🌲".repeat(257) }],
  ])("rejects %s as ConfigurationError(field=tags)", (_label, tags) => {
    let caught: unknown;
    try {
      resolveConfig({ api_key: VALID_KEY, tags } as unknown as SolwynConfigOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("tags");
  });

  it("validates parsed environment tags with the SOLWYN_TAGS parameter label", () => {
    expect(() =>
      resolveConfigFromEnvSnapshot(
        { api_key: VALID_KEY },
        { SOLWYN_TAGS: `key=${"v".repeat(257)}` },
      ),
    ).toThrow(/SOLWYN_TAGS/);
  });

  it("lets an explicit empty record beat the environment and normalize to undefined", () => {
    const config = resolveConfigFromEnvSnapshot(
      { api_key: VALID_KEY, tags: {} },
      { SOLWYN_TAGS: "ambient=poison" },
    );
    expect(config.tags).toBeUndefined();
  });

  it("copies explicit constructor input into resolved config", () => {
    const caller = { team: "platform" };
    const config = resolveConfig({ api_key: VALID_KEY, tags: caller });
    caller.team = "mutated";
    expect(config.tags).toEqual({ team: "platform" });
  });

  it.each([
    [
      "throwing",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("secret-tag=value\nforged");
            },
          },
        ),
    ],
    [
      "revoked",
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
  ])("rejects a %s tag proxy without exposing trap-controlled text", (_label, makeTags) => {
    let caught: unknown;
    try {
      resolveConfig({
        api_key: VALID_KEY,
        tags: makeTags() as Record<string, string>,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("tags");
    expect((caught as Error).message).toBe(
      "tags requires a plain record of string keys to string values",
    );
    expect((caught as Error).message).not.toContain("secret-tag");
    expect((caught as Error).message).not.toContain("\n");
  });

  it("uses a fixed config message for unexpected non-Solwyn tag failures", () => {
    const secret = "secret-tag=value\nforged";
    const fromEntries = vi.spyOn(Object, "fromEntries").mockImplementationOnce(() => {
      throw new Error(secret);
    });
    let caught: unknown;
    try {
      resolveConfig({ api_key: VALID_KEY, tags: { team: "platform" } });
    } catch (error) {
      caught = error;
    } finally {
      fromEntries.mockRestore();
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("tags");
    expect((caught as Error).message).toBe("tags are invalid");
    expect((caught as Error).message).not.toContain("secret-tag");
    expect((caught as Error).message).not.toContain("\n");
  });
});

describe("SOLWYN_FAIL_OPEN string coercion", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["TRUE", true],
    ["Yes", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["anything-else", false],
  ])("%s -> %s", (raw, expected) => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_FAIL_OPEN", raw);
    const config = resolveConfig({ providers: providers() });
    expect(config.fail_open).toBe(expected);
  });

  it("defaults fail_open to true when unset", () => {
    const config = resolveConfig({ api_key: VALID_KEY, providers: providers() });
    expect(config.fail_open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Presence checks never use truthiness: explicit false, 0, and "" beat the environment value.
// ---------------------------------------------------------------------------

describe("D3 presence-check precedence (explicit falsy beats env)", () => {
  it("explicit fail_open=false wins over SOLWYN_FAIL_OPEN=true", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_FAIL_OPEN", "true");
    const config = resolveConfig({ fail_open: false, providers: providers() });
    expect(config.fail_open).toBe(false);
  });

  it("explicit numeric 0 wins over a non-zero env var", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    // budget_check_cache_ttl permits 0 even though the reporter knobs do not, so it
    // is the right field to pin "explicit falsy 0 beats a non-zero env var".
    vi.stubEnv("SOLWYN_BUDGET_CHECK_CACHE_TTL", "5");
    const config = resolveConfig({ budget_check_cache_ttl: 0, providers: providers() });
    expect(config.budget_check_cache_ttl).toBe(0);
  });

  it("explicit empty-string api_url wins over a non-empty env var", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_API_URL", "https://from-env.test");
    const config = resolveConfig({ api_url: "", providers: providers() });
    expect(config.api_url).toBe("");
  });

  it("loadConfigFromEnv keeps an explicit false rather than reading env", () => {
    vi.stubEnv("SOLWYN_FAIL_OPEN", "true");
    const raw = loadConfigFromEnv({ fail_open: false });
    expect(raw["fail_open"]).toBe(false);
  });

  it("loadConfigFromEnv only reads env for absent (undefined) fields", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_BUDGET_MODE", "hard_deny");
    const raw = loadConfigFromEnv({ api_key: undefined, budget_mode: "alert_only" });
    expect(raw["api_key"]).toBe(VALID_KEY); // undefined option -> env consulted
    expect(raw["budget_mode"]).toBe("alert_only"); // present option -> env ignored
  });

  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["false", false],
    ["0", false],
    ["no", false],
  ])("coerces SOLWYN_LEASE_ENABLED=%s to %s", (raw, expected) => {
    const config = resolveConfigFromEnvSnapshot(
      { api_key: VALID_KEY },
      { SOLWYN_LEASE_ENABLED: raw },
    );
    expect(config.lease_enabled).toBe(expected);
  });

  it("coerces the lease bound env value and lets explicit false/bound options win", () => {
    expect(
      resolveConfigFromEnvSnapshot(
        { api_key: VALID_KEY },
        {
          SOLWYN_LEASE_ENABLED: "false",
          SOLWYN_LEASE_OUTPUT_BOUND_DEFAULT: "8192",
        },
      ),
    ).toMatchObject({ lease_enabled: false, lease_output_bound_default: 8192 });

    expect(
      resolveConfigFromEnvSnapshot(
        {
          api_key: VALID_KEY,
          lease_enabled: false,
          lease_output_bound_default: 2048,
        },
        {
          SOLWYN_LEASE_ENABLED: "true",
          SOLWYN_LEASE_OUTPUT_BOUND_DEFAULT: "8192",
        },
      ),
    ).toMatchObject({ lease_enabled: false, lease_output_bound_default: 2048 });
  });

  it.each([0, -1, 1.5, true])("rejects invalid lease_output_bound_default=%j", (value) => {
    let caught: unknown;
    try {
      resolveConfig({
        api_key: VALID_KEY,
        lease_output_bound_default: value,
      } as SolwynConfigOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("lease_output_bound_default");
  });

  it("rejects an unknown lease-shaped snake-case option", () => {
    expect(() =>
      resolveConfig({
        api_key: VALID_KEY,
        lease_output_default: 123,
      } as unknown as SolwynConfigOptions),
    ).toThrow(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// project_id removal.
// ---------------------------------------------------------------------------

describe("project_id is absent from config", () => {
  it("SOLWYN_PROJECT_ID env var has zero effect on the resolved config", () => {
    vi.stubEnv("SOLWYN_API_KEY", VALID_KEY);
    vi.stubEnv("SOLWYN_PROJECT_ID", "proj_deadbeefdeadbeefdeadbeef");
    const config = resolveConfig({ providers: providers() });
    expect(Object.hasOwn(config, "project_id")).toBe(false);
    expect((config as Record<string, unknown>)["project_id"]).toBeUndefined();
  });

  it("loadConfigFromEnv never reads SOLWYN_PROJECT_ID", () => {
    vi.stubEnv("SOLWYN_PROJECT_ID", "proj_deadbeefdeadbeefdeadbeef");
    const raw = loadConfigFromEnv({});
    expect(raw["project_id"]).toBeUndefined();
  });

  it("a stray project_id key is rejected by the strict schema", () => {
    expect(() =>
      resolveConfig({ api_key: VALID_KEY, project_id: "x" } as unknown as SolwynConfigOptions),
    ).toThrow(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// Missing or malformed api_key.
// ---------------------------------------------------------------------------

describe("api_key validation", () => {
  it("absent api_key (no kwarg, no env) raises ConfigurationError(field=api_key)", () => {
    let caught: unknown;
    try {
      resolveConfig({ providers: providers() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("api_key");
    expect((caught as ConfigurationError).message.length).toBeGreaterThan(0);
  });

  it.each([
    ["bad prefix", `sk_live_${"a".repeat(64)}`],
    ["legacy sk_solwyn_ prefix", `sk_solwyn_${"a".repeat(64)}`],
    ["too short (63 hex)", `sk_proj_${"a".repeat(63)}`],
    ["too long (65 hex)", `sk_proj_${"a".repeat(65)}`],
    ["empty string", ""],
    ["unicode homograph", `sk_proj_${"а".repeat(64)}`],
    ["path traversal ..", `sk_proj_..${"a".repeat(62)}`],
    ["path traversal /", `sk_proj_/${"a".repeat(63)}`],
    ["path traversal \\", `sk_proj_\\${"a".repeat(63)}`],
  ])("rejects %s with ConfigurationError(field=api_key)", (_label, key) => {
    let caught: unknown;
    try {
      resolveConfig({ api_key: key, providers: providers() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("api_key");
    expect((caught as ConfigurationError).message.length).toBeGreaterThan(0);
  });

  it("legacy sk_solwyn_ key is rejected with a sk_proj_ message", () => {
    expect(() =>
      resolveConfig({ api_key: `sk_solwyn_${"a".repeat(64)}`, providers: providers() }),
    ).toThrow(/sk_proj_/);
  });

  it("ConfigurationError is catchable as the SDK base SolwynError", () => {
    let caught: unknown;
    try {
      resolveConfig({ api_key: "bad", providers: providers() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SolwynError);
    expect(caught).toBeInstanceOf(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// Provider chain.
// ---------------------------------------------------------------------------

describe("provider chain", () => {
  it("an empty providers chain raises ConfigurationError(field=providers)", () => {
    const config = resolveConfig({ api_key: VALID_KEY, providers: [] });
    let caught: unknown;
    try {
      validateProviderChain(config);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("providers");
    expect((caught as ConfigurationError).message).toBe("at least one provider entry required");
  });

  it("a single-entry chain is valid and its entry is the primary (providers[0])", () => {
    const config = validateProviderChain(
      resolveConfig({
        api_key: VALID_KEY,
        providers: [{ provider: "anthropic", model: "claude" }],
      }),
    );
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toEqual({
      provider: "anthropic",
      model: "claude",
      default_params: {},
    });
  });

  it("ProviderEntry round-trips through serialize -> deserialize without loss", () => {
    const entry = ProviderEntrySchema.parse({
      provider: "bedrock",
      model: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude",
      default_params: { temperature: 0.2, top_p: 0.9 },
    });
    const roundTripped = ProviderEntrySchema.parse(JSON.parse(JSON.stringify(entry)));
    expect(roundTripped).toEqual(entry);
    expect(roundTripped.default_params).toEqual({ temperature: 0.2, top_p: 0.9 });
  });

  it("ProviderEntry rejects a smuggled api_key/base_url credential field", () => {
    expect(() =>
      ProviderEntrySchema.parse({ provider: "openai", model: "gpt-4o", api_key: "secret" }),
    ).toThrow();
    expect(() =>
      ProviderEntrySchema.parse({ provider: "openai", model: "gpt-4o", base_url: "http://x" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Failover option defaults and overrides.
// ---------------------------------------------------------------------------

describe("failover / tuning knobs", () => {
  it("exposes the exact default values for every knob", () => {
    const config = resolveConfig({ api_key: VALID_KEY, providers: providers() });
    expect(config.failover_total_timeout).toBe(30.0);
    expect(config.failover_hop_read_timeout).toBe(600);
    expect(config.failover_idempotency).toBe("safe");
    expect(config.same_provider_retries).toBe(0);
    expect(config.circuit_breaker_recovery_timeout_jitter).toBe(0.2);
    expect(config.default_params).toEqual({});
    expect(config.circuit_breaker_failure_threshold).toBe(3);
    expect(config.circuit_breaker_recovery_timeout).toBe(60);
    expect(config.circuit_breaker_success_threshold).toBe(2);
    expect(config.budget_check_cache_ttl).toBe(5);
    expect(config.reporter_batch_size).toBe(50);
    expect(config.reporter_flush_interval).toBe(5.0);
    expect(config.reporter_max_queue_size).toBe(10_000);
    expect(config.reporter_max_in_flight).toBe(3);
    expect(config.reporter_max_send_attempts).toBe(5);
    expect(config.reporter_retry_backoff_base).toBe(1.0);
    expect(config.reporter_retry_backoff_cap).toBe(60.0);
    expect(config.reporter_shutdown_deadline).toBe(5.0);
    expect(config.breaker_report_heartbeat).toBe(60.0);
  });

  it("holds every overridden knob value verbatim", () => {
    const config = resolveConfig({
      api_key: VALID_KEY,
      providers: providers(),
      failover_total_timeout: 12.5,
      failover_hop_read_timeout: 42,
      failover_idempotency: "always",
      same_provider_retries: 2,
      default_params: { temperature: 0.0 },
    });
    expect(config.failover_total_timeout).toBe(12.5);
    expect(config.failover_hop_read_timeout).toBe(42);
    expect(config.failover_idempotency).toBe("always");
    expect(config.same_provider_retries).toBe(2);
    expect(config.default_params).toEqual({ temperature: 0.0 });
  });

  it("keeps the eight-field governed defaults and picked snapshot complete and frozen", () => {
    expect(FAILOVER_TUNING_DEFAULTS).toEqual({
      failover_total_timeout: 30,
      failover_hop_read_timeout: 600,
      failover_idempotency: "safe",
      same_provider_retries: 0,
      circuit_breaker_recovery_timeout_jitter: 0.2,
      circuit_breaker_failure_threshold: 3,
      circuit_breaker_recovery_timeout: 60,
      circuit_breaker_success_threshold: 2,
    });

    const picked = pickFailoverTuning(
      resolveConfig({
        api_key: VALID_KEY,
        providers: providers(),
        failover_total_timeout: 12.5,
        failover_hop_read_timeout: 42,
        failover_idempotency: "always",
        same_provider_retries: 2,
        circuit_breaker_recovery_timeout_jitter: 0.05,
        circuit_breaker_failure_threshold: 8,
        circuit_breaker_recovery_timeout: 75,
        circuit_breaker_success_threshold: 6,
      }),
    );

    expect(picked).toEqual({
      failover_total_timeout: 12.5,
      failover_hop_read_timeout: 42,
      failover_idempotency: "always",
      same_provider_retries: 2,
      circuit_breaker_recovery_timeout_jitter: 0.05,
      circuit_breaker_failure_threshold: 8,
      circuit_breaker_recovery_timeout: 75,
      circuit_breaker_success_threshold: 6,
    });
    expect(Object.isFrozen(picked)).toBe(true);
  });

  it.each([
    "failover_total_timeout",
    "failover_hop_read_timeout",
  ] as const)("%s rejects booleans with the exact typed issue", (field) => {
    for (const value of [true, false]) {
      let caught: unknown;
      try {
        resolveConfig({
          api_key: VALID_KEY,
          providers: providers(),
          [field]: value,
        } as unknown as SolwynConfigOptions);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).field).toBe(field);
      expect((caught as ConfigurationError).message).toBe(
        "timeout bounds must be numbers, not booleans",
      );
    }
  });

  it.each([
    ["failover_total_timeout", Number.NaN],
    ["failover_total_timeout", Number.POSITIVE_INFINITY],
    ["failover_total_timeout", Number.NEGATIVE_INFINITY],
    ["failover_total_timeout", "not-a-number"],
    ["failover_hop_read_timeout", Number.NaN],
    ["failover_hop_read_timeout", Number.POSITIVE_INFINITY],
    ["failover_hop_read_timeout", Number.NEGATIVE_INFINITY],
    ["failover_hop_read_timeout", "not-a-number"],
    ["failover_hop_read_timeout", 0],
    ["failover_hop_read_timeout", -1],
  ] as const)("rejects invalid %s=%s with the typed field", (field, value) => {
    let caught: unknown;
    try {
      resolveConfig({
        api_key: VALID_KEY,
        providers: providers(),
        [field]: value,
      } as unknown as SolwynConfigOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });

  it.each([0, -1, 0.25])("accepts failover_total_timeout=%s", (value) => {
    expect(
      resolveConfig({
        api_key: VALID_KEY,
        providers: providers(),
        failover_total_timeout: value,
      }).failover_total_timeout,
    ).toBe(value);
  });

  it("accepts a finite-positive failover_hop_read_timeout", () => {
    expect(
      resolveConfig({
        api_key: VALID_KEY,
        providers: providers(),
        failover_hop_read_timeout: 0.001,
      }).failover_hop_read_timeout,
    ).toBe(0.001);
  });

  it("does not load failover_hop_read_timeout from an invented environment variable", () => {
    expect(
      resolveConfigFromEnvSnapshot(
        { api_key: VALID_KEY, providers: providers() },
        { SOLWYN_FAILOVER_HOP_READ_TIMEOUT: "42" },
      ).failover_hop_read_timeout,
    ).toBe(600);
  });

  it("per-entry default_params are preserved distinctly from the global default_params", () => {
    const config = resolveConfig({
      api_key: VALID_KEY,
      default_params: { temperature: 0.0 },
      providers: [{ provider: "openai", model: "gpt-4o", default_params: { temperature: 1.0 } }],
    });
    expect(config.default_params).toEqual({ temperature: 0.0 });
    expect(config.providers[0]?.default_params).toEqual({ temperature: 1.0 });
  });

  it("same_provider_retries=-1 fails the schema directly (ge=0)", () => {
    expect(() =>
      SolwynConfigSchema.parse({
        api_key: VALID_KEY,
        providers: [{ provider: "openai", model: "gpt-4o" }],
        same_provider_retries: -1,
      }),
    ).toThrow();
  });

  it("same_provider_retries=-1 via resolveConfig surfaces ConfigurationError(field=same_provider_retries)", () => {
    let caught: unknown;
    try {
      resolveConfig({ api_key: VALID_KEY, providers: providers(), same_provider_retries: -1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("same_provider_retries");
    expect((caught as ConfigurationError).message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reporter knobs must be strictly positive. A non-positive value would
// deadlock or spin the background flush loop at runtime (batchSize=0 → i+=0
// infinite loop; maxInFlight=0 → Promise.race over an empty pending set never
// settles and close() never resolves), so misconfiguration must throw a typed
// ConfigurationError at construction — asserted here WITHOUT running the spin.
// ---------------------------------------------------------------------------

describe("reporter knob positivity (F21)", () => {
  const nonPositiveCases: Array<[keyof SolwynConfigOptions, number]> = [
    ["reporter_batch_size", 0],
    ["reporter_batch_size", -1],
    ["reporter_flush_interval", 0],
    ["reporter_flush_interval", -0.5],
    ["reporter_max_queue_size", 0],
    ["reporter_max_queue_size", -10],
    ["reporter_max_in_flight", 0],
    ["reporter_max_in_flight", -3],
  ];

  for (const [field, value] of nonPositiveCases) {
    it(`${field}=${value} surfaces ConfigurationError(field=${field})`, () => {
      let caught: unknown;
      try {
        resolveConfig({ api_key: VALID_KEY, providers: providers(), [field]: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).field).toBe(field);
      expect((caught as ConfigurationError).message.length).toBeGreaterThan(0);
    });
  }

  it("the minimum valid value (1, and a fractional flush interval) is accepted", () => {
    const config = resolveConfig({
      api_key: VALID_KEY,
      providers: providers(),
      reporter_batch_size: 1,
      reporter_flush_interval: 0.001,
      reporter_max_queue_size: 1,
      reporter_max_in_flight: 1,
    });
    expect(config.reporter_batch_size).toBe(1);
    expect(config.reporter_flush_interval).toBe(0.001);
    expect(config.reporter_max_queue_size).toBe(1);
    expect(config.reporter_max_in_flight).toBe(1);
  });
});

describe("reporter reliability knobs", () => {
  it("loads all five knobs from their exact environment variables", () => {
    const config = resolveConfigFromEnvSnapshot(
      { api_key: VALID_KEY, providers: providers() },
      {
        SOLWYN_REPORTER_MAX_SEND_ATTEMPTS: "7",
        SOLWYN_REPORTER_RETRY_BACKOFF_BASE: "0.25",
        SOLWYN_REPORTER_RETRY_BACKOFF_CAP: "12.5",
        SOLWYN_REPORTER_SHUTDOWN_DEADLINE: "0",
        SOLWYN_BREAKER_REPORT_HEARTBEAT: "15",
      },
    );

    expect(config).toMatchObject({
      reporter_max_send_attempts: 7,
      reporter_retry_backoff_base: 0.25,
      reporter_retry_backoff_cap: 12.5,
      reporter_shutdown_deadline: 0,
      breaker_report_heartbeat: 15,
    });
  });

  it.each([
    ["reporter_max_send_attempts", 0],
    ["reporter_max_send_attempts", 1.5],
    ["reporter_retry_backoff_base", 0],
    ["reporter_retry_backoff_base", Number.POSITIVE_INFINITY],
    ["reporter_retry_backoff_cap", -1],
    ["reporter_retry_backoff_cap", Number.NaN],
    ["reporter_shutdown_deadline", -1],
    ["reporter_shutdown_deadline", Number.POSITIVE_INFINITY],
    ["breaker_report_heartbeat", 0],
    ["breaker_report_heartbeat", Number.NaN],
  ] as const)("rejects invalid %s=%s", (field, value) => {
    let caught: unknown;
    try {
      resolveConfig({
        api_key: VALID_KEY,
        providers: providers(),
        [field]: value,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe(field);
  });
});

// ---------------------------------------------------------------------------
// Strict schema rejects unknown fields.
// ---------------------------------------------------------------------------

describe("strict schema", () => {
  it("rejects unknown/extra keys outright", () => {
    let caught: unknown;
    try {
      resolveConfig({
        api_key: VALID_KEY,
        providers: providers(),
        bogus_field: 1,
      } as unknown as SolwynConfigOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
  });
});
