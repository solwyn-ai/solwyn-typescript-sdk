import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors";
import {
  LEASE_GRANT_PATH,
  LEASE_RENEW_PATH,
  LEASE_SURRENDER_PATH,
  TAG_KEY_MAX_LENGTH as ROOT_TAG_KEY_MAX_LENGTH,
  TAG_VALUE_MAX_LENGTH as ROOT_TAG_VALUE_MAX_LENGTH,
  TAGS_MAX_KEYS as ROOT_TAGS_MAX_KEYS,
} from "../../src/index";
import { createTokenDetails } from "../../src/token-details";
import type {
  BudgetConfirmRequest,
  LeaseGrantRequest,
  LeaseRenewRequest,
  LeaseSurrenderRequest,
  MetadataEvent,
} from "../../src/types";
import * as validation from "../../src/validation";
import {
  BudgetCheckRequestSchema,
  BudgetCheckResponseSchema,
  BudgetConfirmRequestSchema,
  LeaseGrantRequestSchema,
  LeaseGrantResponseSchema,
  LeasePostureSchema,
  LeaseRenewRequestSchema,
  LeaseSurrenderRequestSchema,
  LeaseSurrenderResponseSchema,
  MediaUsageSchema,
  MetadataEventSchema,
  omitNullish,
  ProviderEntrySchema,
  serializeBudgetConfirmRequest,
  serializeLeaseGrantRequest,
  serializeLeaseRenewRequest,
  serializeLeaseSurrenderRequest,
  serializeMetadataEvent,
  validateProjectId,
  validateProjectKeyFormat,
} from "../../src/validation";

// ---------------------------------------------------------------------------
// Project key / ID validators.
// ---------------------------------------------------------------------------

describe("validateProjectKeyFormat", () => {
  const valid = `sk_proj_${"a".repeat(64)}`;

  it("accepts sk_proj_ + 64 lowercase hex and returns it unchanged", () => {
    expect(validateProjectKeyFormat(valid)).toBe(valid);
  });

  it.each([
    ["wrong prefix", `sk_solwyn_${"a".repeat(64)}`],
    ["uppercase hex", `sk_proj_${"A".repeat(64)}`],
    ["63 chars", `sk_proj_${"a".repeat(63)}`],
    ["65 chars", `sk_proj_${"a".repeat(65)}`],
  ])("rejects %s with a message containing sk_proj_", (_label, input) => {
    expect(() => validateProjectKeyFormat(input)).toThrow(ConfigurationError);
    expect(() => validateProjectKeyFormat(input)).toThrow(/sk_proj_/);
  });

  it("there is NO validateApiKeyFormat legacy symbol", () => {
    expect((validation as Record<string, unknown>)["validateApiKeyFormat"]).toBeUndefined();
  });
});

describe("validateProjectId", () => {
  const valid = `proj_${"a".repeat(24)}`;

  it("accepts proj_ + 24 lowercase hex and returns it unchanged", () => {
    expect(validateProjectId(valid)).toBe(valid);
  });

  it.each([
    ["old 8-char format", "proj_abc12345"],
    ["uppercase hex", `proj_${"A".repeat(24)}`],
    ["non-hex char", `proj_g${"a".repeat(23)}`],
    ["25 chars", `proj_${"a".repeat(25)}`],
  ])("rejects %s with a message containing '24 lowercase hex'", (_label, input) => {
    expect(() => validateProjectId(input)).toThrow(ConfigurationError);
    expect(() => validateProjectId(input)).toThrow(/24 lowercase hex/);
  });
});

describe("security checks (shared, in order)", () => {
  it("rejects an empty string", () => {
    expect(() => validateProjectId("")).toThrow(ConfigurationError);
    expect(() => validateProjectKeyFormat("")).toThrow(ConfigurationError);
  });

  it("rejects non-ASCII input", () => {
    expect(() => validateProjectId("proj_café00000000000000000000")).toThrow(/ASCII/);
  });

  it("rejects path-traversal substrings before the regex runs", () => {
    expect(() => validateProjectId("../proj_aaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(/path separators/);
    expect(() => validateProjectKeyFormat("sk_proj_/etc/passwd")).toThrow(/path separators/);
  });
});

// ---------------------------------------------------------------------------
// ProviderEntry.
// ---------------------------------------------------------------------------

describe("ProviderEntrySchema", () => {
  it("minimal construction yields default_params = {}", () => {
    const entry = ProviderEntrySchema.parse({ provider: "openai", model: "gpt-4o" });
    expect(entry.default_params).toEqual({});
  });

  it("default_params is independent per parsed instance", () => {
    const a = ProviderEntrySchema.parse({ provider: "openai", model: "gpt-4o" });
    const b = ProviderEntrySchema.parse({ provider: "anthropic", model: "claude" });
    (a.default_params as Record<string, unknown>)["mutated"] = true;
    expect(b.default_params).toEqual({});
  });

  it("rejects an api_key key via extra-forbid", () => {
    expect(
      ProviderEntrySchema.safeParse({ provider: "openai", model: "gpt-4o", api_key: "sk" }).success,
    ).toBe(false);
  });

  it("rejects a base_url key via extra-forbid", () => {
    expect(
      ProviderEntrySchema.safeParse({
        provider: "openai",
        model: "gpt-4o",
        base_url: "http://x",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strictness — every wire schema forbids extra keys.
// ---------------------------------------------------------------------------

describe("strict objects reject unknown keys", () => {
  it("MediaUsage rejects an extra key", () => {
    expect(MediaUsageSchema.safeParse({ image_count: 1, extra: 1 }).success).toBe(false);
  });

  it("MetadataEvent rejects an extra key", () => {
    const base = minimalMetadataEvent();
    expect(MetadataEventSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("BudgetConfirmRequest rejects an extra key", () => {
    const base = minimalConfirm();
    expect(BudgetConfirmRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("BudgetCheckResponse rejects an extra key", () => {
    expect(
      BudgetCheckResponseSchema.safeParse({
        allowed: true,
        remaining_budget: 1,
        mode: "hard_deny",
        budget_limit: 1,
        current_usage: 0,
        project_id: "p",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("lease wire objects reject unknown keys", () => {
    expect(
      LeaseGrantRequestSchema.safeParse({
        agent_run_id: "run-1",
        holder_id: "holder-1",
        model: "gpt-4o",
        provider: "openai",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      LeasePostureSchema.safeParse({ mode: "hard_deny", on_unreachable: "fail_open", extra: true })
        .success,
    ).toBe(false);
    expect(
      LeaseGrantResponseSchema.safeParse({
        eligible: true,
        allowed: true,
        project_id: "project-1",
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 25,
        remaining_budget: 75,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      LeaseRenewRequestSchema.safeParse({
        lease_id: "lease-1",
        holder_id: "holder-1",
        generation: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      LeaseSurrenderRequestSchema.safeParse({
        lease_id: "lease-1",
        holder_id: "holder-1",
        generation: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      LeaseSurrenderResponseSchema.safeParse({ released_tokens: 0, extra: true }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A4.1 lease wire models.
// ---------------------------------------------------------------------------

describe("lease request schemas", () => {
  const grant = {
    agent_run_id: "run-1",
    holder_id: "holder-1",
    model: "gpt-4o",
    provider: "openai",
  } as const;
  const renew = { lease_id: "lease-1", holder_id: "holder-1", generation: 1 } as const;

  it("defaults grant hints and omits an absent directive opt-in on the wire", () => {
    const parsed = LeaseGrantRequestSchema.parse(grant) as LeaseGrantRequest;
    expect(serializeLeaseGrantRequest(parsed)).toEqual({
      ...grant,
      fallback_providers: [],
      fallback_models: [],
      fail_open: true,
      estimated_input_tokens: 0,
    });
  });

  it("allows only directive version 1 and preserves explicit null omission", () => {
    const parsed = LeaseGrantRequestSchema.parse({ ...grant, run_directive_version: "1" });
    expect(serializeLeaseGrantRequest(parsed as LeaseGrantRequest)["run_directive_version"]).toBe(
      "1",
    );
    expect(
      serializeLeaseGrantRequest(
        LeaseGrantRequestSchema.parse({
          ...grant,
          run_directive_version: null,
        }) as LeaseGrantRequest,
      ),
    ).not.toHaveProperty("run_directive_version");
    expect(
      LeaseGrantRequestSchema.safeParse({ ...grant, run_directive_version: "2" }).success,
    ).toBe(false);
  });

  it("enforces aligned fallbacks through source indexes zero through eight", () => {
    const providers = Array.from({ length: 8 }, () => "anthropic");
    const models = Array.from({ length: 8 }, (_, index) => `claude-${index}`);
    expect(
      LeaseGrantRequestSchema.safeParse({
        ...grant,
        fallback_providers: providers,
        fallback_models: models,
      }).success,
    ).toBe(true);
    expect(
      LeaseGrantRequestSchema.safeParse({
        ...grant,
        fallback_providers: providers,
        fallback_models: models.slice(0, 7),
      }).success,
    ).toBe(false);
    expect(
      LeaseGrantRequestSchema.safeParse({
        ...grant,
        fallback_providers: [...providers, "openai"],
        fallback_models: [...models, "gpt-4o"],
      }).success,
    ).toBe(false);
  });

  it("pins every grant string and counter boundary", () => {
    expect(
      LeaseGrantRequestSchema.safeParse({
        ...grant,
        agent_run_id: "r".repeat(256),
        holder_id: "h".repeat(64),
        model: "m".repeat(2_048),
        estimated_input_tokens: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    for (const candidate of [
      { ...grant, agent_run_id: "" },
      { ...grant, agent_run_id: "r".repeat(257) },
      { ...grant, holder_id: "h".repeat(65) },
      { ...grant, model: "m".repeat(2_049) },
      { ...grant, estimated_input_tokens: 0.5 },
      { ...grant, estimated_input_tokens: 2 ** 64 },
    ]) {
      expect(LeaseGrantRequestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects rounded signed-int64 counter values outside JavaScript's lossless integer subset", () => {
    const roundedInt64Max = Number("9223372036854775807");
    const roundedInt64MaxPlusOne = Number("9223372036854775808");
    expect(roundedInt64MaxPlusOne).toBe(roundedInt64Max);

    for (const counter of [roundedInt64Max, roundedInt64MaxPlusOne]) {
      expect(
        LeaseGrantRequestSchema.safeParse({ ...grant, estimated_input_tokens: counter }).success,
      ).toBe(false);
      for (const field of [
        "spent_tokens",
        "reserved_tokens",
        "uncounted_calls",
        "uncounted_tokens",
      ] as const) {
        expect(LeaseRenewRequestSchema.safeParse({ ...renew, [field]: counter }).success).toBe(
          false,
        );
      }
      expect(
        LeaseSurrenderRequestSchema.safeParse({ ...renew, spent_tokens: counter }).success,
      ).toBe(false);
    }
  });

  it("defaults renewal counters, omits null redeclaration fields, and bounds required values", () => {
    const parsed = LeaseRenewRequestSchema.parse({
      ...renew,
      model: null,
      provider: null,
      run_directive_version: null,
    }) as LeaseRenewRequest;
    expect(serializeLeaseRenewRequest(parsed)).toEqual({
      ...renew,
      spent_tokens: 0,
      reserved_tokens: 0,
      uncounted_calls: 0,
      uncounted_tokens: 0,
      fallback_providers: [],
      fallback_models: [],
    });
    expect(LeaseRenewRequestSchema.safeParse({ ...renew, generation: 0 }).success).toBe(false);
    expect(LeaseRenewRequestSchema.safeParse({ ...renew, spent_tokens: -1 }).success).toBe(false);
    expect(
      LeaseRenewRequestSchema.safeParse({
        ...renew,
        fallback_providers: ["openai"],
        fallback_models: [],
      }).success,
    ).toBe(false);
  });

  it("pins renewal strings, counters, and aligned fallback boundaries", () => {
    const providers = Array.from({ length: 8 }, () => "anthropic");
    const models = Array.from({ length: 8 }, (_, index) => `claude-${index}`);
    expect(
      LeaseRenewRequestSchema.safeParse({
        lease_id: "l".repeat(64),
        holder_id: "h".repeat(64),
        generation: 1,
        spent_tokens: Number.MAX_SAFE_INTEGER,
        model: "m".repeat(2_048),
        fallback_providers: providers,
        fallback_models: models,
      }).success,
    ).toBe(true);
    for (const candidate of [
      { ...renew, lease_id: "l".repeat(65) },
      { ...renew, holder_id: "h".repeat(65) },
      { ...renew, model: "m".repeat(2_049) },
      { ...renew, uncounted_tokens: 0.5 },
      { ...renew, uncounted_tokens: 2 ** 64 },
      {
        ...renew,
        fallback_providers: [...providers, "openai"],
        fallback_models: [...models, "gpt-5"],
      },
    ]) {
      expect(LeaseRenewRequestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("defaults surrender spend and rejects invalid generation or spending", () => {
    const parsed = LeaseSurrenderRequestSchema.parse(renew) as LeaseSurrenderRequest;
    expect(serializeLeaseSurrenderRequest(parsed)).toEqual({ ...renew, spent_tokens: 0 });
    expect(LeaseSurrenderRequestSchema.safeParse({ ...renew, generation: 0 }).success).toBe(false);
    expect(LeaseSurrenderRequestSchema.safeParse({ ...renew, spent_tokens: -1 }).success).toBe(
      false,
    );
    expect(
      LeaseSurrenderRequestSchema.safeParse({
        lease_id: "l".repeat(64),
        holder_id: "h".repeat(64),
        generation: 1,
        spent_tokens: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    expect(
      LeaseSurrenderRequestSchema.safeParse({ ...renew, lease_id: "l".repeat(65) }).success,
    ).toBe(false);
    expect(
      LeaseSurrenderRequestSchema.safeParse({ ...renew, holder_id: "h".repeat(65) }).success,
    ).toBe(false);
    expect(LeaseSurrenderRequestSchema.safeParse({ ...renew, spent_tokens: 2 ** 64 }).success).toBe(
      false,
    );
  });
});

describe("lease endpoint constants", () => {
  it("exposes the three adopted lease routes from the public entry point", () => {
    expect([LEASE_GRANT_PATH, LEASE_RENEW_PATH, LEASE_SURRENDER_PATH]).toEqual([
      "/api/v1/budgets/lease",
      "/api/v1/budgets/lease/renew",
      "/api/v1/budgets/lease/surrender",
    ]);
  });
});

describe("lease response schemas", () => {
  const display = {
    eligible: true,
    allowed: true,
    project_id: "project-1",
    mode: "hard_deny",
    budget_limit: 100,
    current_usage: 25,
    remaining_budget: 75,
  } as const;

  it("requires exactly the seven display/verdict fields and accepts every optional lease block field", () => {
    expect(LeaseGrantResponseSchema.safeParse(display).success).toBe(true);
    const missing = { ...display } as Record<string, unknown>;
    delete missing["remaining_budget"];
    expect(LeaseGrantResponseSchema.safeParse(missing).success).toBe(false);
    expect(
      LeaseGrantResponseSchema.safeParse({
        ...display,
        ineligible_reason: null,
        denied_by_period: null,
        run_control: {
          version: "1",
          action: "terminate",
          agent_run_id: "run-1",
          reason: "manual_kill",
        },
        lease_id: "x".repeat(65),
        generation: null,
        granted_tokens: null,
        refresh_interval_s: null,
        lease_length_s: null,
        headroom_share_tokens: null,
        posture: null,
        final_grant: null,
      }).success,
    ).toBe(true);
  });

  it("keeps generation zero valid at the inbound response wire boundary", () => {
    expect(
      LeaseGrantResponseSchema.safeParse({
        ...display,
        lease_id: "lease-zero",
        generation: 0,
        granted_tokens: 100,
        refresh_interval_s: 20,
        lease_length_s: 120,
        headroom_share_tokens: 10,
        posture: { mode: "alert_only", on_unreachable: "fail_open" },
        final_grant: false,
      }).success,
    ).toBe(true);
  });

  it("accepts the spec-defined posture and surrender response", () => {
    expect(
      LeasePostureSchema.parse({ mode: "alert_only", on_unreachable: "local_enforce" }),
    ).toEqual({ mode: "alert_only", on_unreachable: "local_enforce" });
    expect(
      LeasePostureSchema.safeParse({ mode: "alert_only", on_unreachable: "other" }).success,
    ).toBe(false);
    expect(LeaseSurrenderResponseSchema.parse({ released_tokens: -3 })).toEqual({
      released_tokens: -3,
    });
    expect(LeaseSurrenderResponseSchema.safeParse({ released_tokens: 0.5 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enumerated contract constraints.
// ---------------------------------------------------------------------------

describe("D1 constraints", () => {
  it("call_id requires the canonical lowercase UUID on MetadataEvent and BudgetConfirmRequest", () => {
    const valid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const invalid = [valid.toUpperCase(), "abc-123", "x".repeat(37)];
    expect(MetadataEventSchema.safeParse(minimalMetadataEvent({ call_id: valid })).success).toBe(
      true,
    );
    expect(BudgetConfirmRequestSchema.safeParse(minimalConfirm({ call_id: valid })).success).toBe(
      true,
    );
    for (const callId of invalid) {
      expect(MetadataEventSchema.safeParse(minimalMetadataEvent({ call_id: callId })).success).toBe(
        false,
      );
      expect(
        BudgetConfirmRequestSchema.safeParse(minimalConfirm({ call_id: callId })).success,
      ).toBe(false);
    }
  });

  it("call_id is required (no default) on both models", () => {
    const meta = minimalMetadataEvent();
    delete (meta as Record<string, unknown>)["call_id"];
    expect(MetadataEventSchema.safeParse(meta).success).toBe(false);

    const confirm = minimalConfirm();
    delete (confirm as Record<string, unknown>)["call_id"];
    expect(BudgetConfirmRequestSchema.safeParse(confirm).success).toBe(false);
  });

  it("denied_by_period is optional AND accepts explicit null (D1)", () => {
    const withoutKey = {
      allowed: true,
      remaining_budget: 1,
      mode: "hard_deny",
      budget_limit: 1,
      current_usage: 0,
      project_id: "p",
    };
    expect(BudgetCheckResponseSchema.safeParse(withoutKey).success).toBe(true);
    expect(
      BudgetCheckResponseSchema.safeParse({ ...withoutKey, denied_by_period: null }).success,
    ).toBe(true);
    expect(
      BudgetCheckResponseSchema.safeParse({ ...withoutKey, denied_by_period: "daily" }).success,
    ).toBe(true);
  });

  it("failover_error_class rejects a leaked message body but accepts a class name (D1)", () => {
    expect(
      MetadataEventSchema.safeParse(
        minimalMetadataEvent({ failover_error_class: "RateLimitError" }),
      ).success,
    ).toBe(true);
    // spaces / punctuation (a leaked str(exc)) are rejected by the pattern
    expect(
      MetadataEventSchema.safeParse(
        minimalMetadataEvent({ failover_error_class: "Error: secret token leaked" }),
      ).success,
    ).toBe(false);
  });

  it("failover_error_class is capped at 64 chars", () => {
    const name = `E${"a".repeat(63)}`; // 64
    const tooLong = `E${"a".repeat(64)}`; // 65
    expect(
      MetadataEventSchema.safeParse(minimalMetadataEvent({ failover_error_class: name })).success,
    ).toBe(true);
    expect(
      MetadataEventSchema.safeParse(minimalMetadataEvent({ failover_error_class: tooLong }))
        .success,
    ).toBe(false);
  });

  it("requested_model is bounded at 2048 chars (Bedrock ARN sizing), not 100", () => {
    expect(
      MetadataEventSchema.safeParse(minimalMetadataEvent({ requested_model: "x".repeat(2048) }))
        .success,
    ).toBe(true);
    expect(
      MetadataEventSchema.safeParse(minimalMetadataEvent({ requested_model: "x".repeat(2049) }))
        .success,
    ).toBe(false);
  });

  it("attempt_index rejects negative integers", () => {
    expect(MetadataEventSchema.safeParse(minimalMetadataEvent({ attempt_index: -1 })).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// BudgetCheckRequest chain hints.
// ---------------------------------------------------------------------------

describe("BudgetCheckRequest chain hints", () => {
  it("both chain-hint arrays default to []", () => {
    const parsed = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
    });
    expect(parsed["fallback_providers"]).toEqual([]);
    expect(parsed["fallback_models"]).toEqual([]);
  });

  it("accepts aligned equal-length arrays", () => {
    expect(
      BudgetCheckRequestSchema.safeParse({
        estimated_input_tokens: 10,
        model: "gpt-4o",
        provider: "openai",
        fallback_providers: ["anthropic", "google"],
        fallback_models: ["claude-3-5-sonnet", "gemini-2.5-flash"],
      }).success,
    ).toBe(true);
  });

  it("rejects misaligned lengths (cross-field validator)", () => {
    expect(
      BudgetCheckRequestSchema.safeParse({
        estimated_input_tokens: 10,
        model: "gpt-4o",
        provider: "openai",
        fallback_providers: ["anthropic"],
        fallback_models: ["claude", "gemini"],
      }).success,
    ).toBe(false);
  });

  it("rejects a 9-element (aligned) pair on the 8-cap", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `m${i}`);
    expect(
      BudgetCheckRequestSchema.safeParse({
        estimated_input_tokens: 10,
        model: "gpt-4o",
        provider: "openai",
        fallback_providers: Array.from({ length: 9 }, () => "openai"),
        fallback_models: nine,
      }).success,
    ).toBe(false);
  });

  it("caps each fallback_models element at 2048 chars", () => {
    expect(
      BudgetCheckRequestSchema.safeParse({
        estimated_input_tokens: 10,
        model: "gpt-4o",
        provider: "openai",
        fallback_providers: ["openai"],
        fallback_models: ["x".repeat(2049)],
      }).success,
    ).toBe(false);
  });

  it("omits all nullable WS0 fields from an unscoped request", () => {
    const parsed = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
      agent_run_id: null,
      tags: null,
      failover_directive_version: null,
      price_hints_version: null,
      run_directive_version: null,
    });
    expect(parsed).toEqual({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
      modality: "text",
      fallback_providers: [],
      fallback_models: [],
    });
  });

  it("preserves tags and all version opt-ins on a scoped wire request", () => {
    const tagKey = "k".repeat(64);
    const tagValue = "v".repeat(256);
    const tags = { [tagKey]: tagValue, empty: "" };
    const parsed = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
      tags,
      failover_directive_version: "1",
      price_hints_version: "1",
      run_directive_version: "1",
    });

    expect(parsed).toEqual({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
      modality: "text",
      fallback_providers: [],
      fallback_models: [],
      tags,
      failover_directive_version: "1",
      price_hints_version: "1",
      run_directive_version: "1",
    });
  });

  it("preserves own __proto__ tag data in budget checks and metadata events", () => {
    const tags = Object.fromEntries([
      ["__proto__", "admin"],
      ["constructor", "safe"],
    ]);
    const budget = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
      tags,
    });
    const metadata = MetadataEventSchema.parse(minimalMetadataEvent({ tags }));

    for (const parsedTags of [budget["tags"], metadata.tags]) {
      expect(parsedTags).toBeDefined();
      expect(Object.getPrototypeOf(parsedTags)).toBe(Object.prototype);
      expect(Object.hasOwn(parsedTags as object, "__proto__")).toBe(true);
      expect(Reflect.get(parsedTags as object, "__proto__")).toBe("admin");
      expect(Object.hasOwn(parsedTags as object, "constructor")).toBe(true);
      expect(Reflect.get(parsedTags as object, "constructor")).toBe("safe");
    }
  });

  it("copies reserved-looking keys from null-prototype tag records", () => {
    const tags = Object.create(null) as Record<string, string>;
    Object.defineProperty(tags, "__proto__", {
      value: "admin",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(tags, "constructor", {
      value: "safe",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const budget = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
      tags,
    });
    const metadata = MetadataEventSchema.parse(minimalMetadataEvent({ tags }));

    for (const parsedTags of [budget["tags"], metadata.tags]) {
      expect(parsedTags).toBeDefined();
      expect(Object.getPrototypeOf(parsedTags)).toBe(Object.prototype);
      expect(Object.hasOwn(parsedTags as object, "__proto__")).toBe(true);
      expect(Reflect.get(parsedTags as object, "__proto__")).toBe("admin");
      expect(Object.hasOwn(parsedTags as object, "constructor")).toBe(true);
      expect(Reflect.get(parsedTags as object, "constructor")).toBe("safe");
    }
  });

  it("keeps an explicit empty tag record present as a fresh ordinary record", () => {
    const input = {};
    const budget = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
      tags: input,
    });
    const metadata = MetadataEventSchema.parse(minimalMetadataEvent({ tags: input }));

    for (const parsedTags of [budget["tags"], metadata.tags]) {
      expect(parsedTags).toBeDefined();
      expect(parsedTags).not.toBe(input);
      expect(Object.getPrototypeOf(parsedTags)).toBe(Object.prototype);
      expect(Reflect.ownKeys(parsedTags as object)).toEqual([]);
    }
    expect(budget["tags"]).not.toBe(metadata.tags);
    expect(MetadataEventSchema.shape.tags.parse(null)).toBeNull();
    expect(MetadataEventSchema.shape.tags.parse(undefined)).toBeUndefined();
  });

  it("rejects hostile tag records without invoking accessors", () => {
    let accessorReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "must-not-be-read";
      },
    });
    const symbol = {};
    Object.defineProperty(symbol, Symbol("tag"), {
      value: "hidden",
      enumerable: true,
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const invalidTags: ReadonlyArray<readonly [string, unknown]> = [
      ["custom prototype", Object.create(Object.fromEntries([["inherited", "value"]]))],
      ["symbol key", symbol],
      ["accessor", accessor],
      ["revoked proxy", revoked.proxy],
      ["non-record", "tag=value"],
      ["non-string value", Object.fromEntries([["key", 1]])],
      ["empty key", Object.fromEntries([["", "value"]])],
      ["overlong key", Object.fromEntries([["k".repeat(65), "value"]])],
      ["overlong value", Object.fromEntries([["key", "v".repeat(257)]])],
      ["NUL key", Object.fromEntries([["bad\0key", "value"]])],
      ["NUL value", Object.fromEntries([["key", "bad\0value"]])],
      [
        "too many keys",
        Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key-${index}`, "value"])),
      ],
    ];

    for (const [label, tags] of invalidTags) {
      const budget = BudgetCheckRequestSchema.safeParse({
        estimated_input_tokens: 10,
        model: "gpt-4o",
        provider: "openai",
        tags,
      });
      const metadata = MetadataEventSchema.safeParse(minimalMetadataEvent({ tags }));
      for (const result of [budget, metadata]) {
        expect(result.success, label).toBe(false);
        if (result.success) throw new Error(`${label} unexpectedly passed tag validation`);
        expect(result.error.issues, label).toHaveLength(1);
        expect(result.error.issues[0], label).toMatchObject({
          code: "invalid_type",
          expected: "record",
          path: ["tags"],
        });
      }
    }
    expect(accessorReads).toBe(0);
  });

  it("accepts a 256-character agent_run_id and rejects 257 characters", () => {
    const base = { estimated_input_tokens: 10, model: "gpt-4o", provider: "openai" };
    expect(
      BudgetCheckRequestSchema.safeParse({ ...base, agent_run_id: "a".repeat(256) }).success,
    ).toBe(true);
    expect(
      BudgetCheckRequestSchema.safeParse({ ...base, agent_run_id: "a".repeat(257) }).success,
    ).toBe(false);
  });

  it("accepts bounded tags including an empty value and rejects invalid tag maps", () => {
    const base = { estimated_input_tokens: 10, model: "gpt-4o", provider: "openai" };
    expect(
      BudgetCheckRequestSchema.safeParse({
        ...base,
        tags: { ["k".repeat(64)]: "v".repeat(256), empty: "" },
      }).success,
    ).toBe(true);
    for (const tags of [
      Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`k${index}`, "v"])),
      { "": "v" },
      { ["k".repeat(65)]: "v" },
      { key: "v".repeat(257) },
      { key: 1 },
    ]) {
      expect(BudgetCheckRequestSchema.safeParse({ ...base, tags }).success).toBe(false);
    }
  });

  it("uses public bounds, counts tag lengths by code point, and rejects NUL", () => {
    expect([ROOT_TAGS_MAX_KEYS, ROOT_TAG_KEY_MAX_LENGTH, ROOT_TAG_VALUE_MAX_LENGTH]).toEqual([
      10, 64, 256,
    ]);
    const budgetBase = { estimated_input_tokens: 10, model: "gpt-4o", provider: "openai" };
    const unicodeTags = { ["🦊".repeat(64)]: "🌲".repeat(256) };
    expect(BudgetCheckRequestSchema.safeParse({ ...budgetBase, tags: unicodeTags }).success).toBe(
      true,
    );
    expect(MetadataEventSchema.safeParse(minimalMetadataEvent({ tags: unicodeTags })).success).toBe(
      true,
    );

    for (const tags of [
      { ["🦊".repeat(65)]: "value" },
      { key: "🌲".repeat(257) },
      { "bad\0key": "value" },
      { key: "bad\0value" },
    ]) {
      expect(BudgetCheckRequestSchema.safeParse({ ...budgetBase, tags }).success).toBe(false);
      expect(MetadataEventSchema.safeParse(minimalMetadataEvent({ tags })).success).toBe(false);
    }
  });

  it("accepts only version 1 opt-ins", () => {
    const base = { estimated_input_tokens: 10, model: "gpt-4o", provider: "openai" };
    for (const field of [
      "failover_directive_version",
      "price_hints_version",
      "run_directive_version",
    ] as const) {
      expect(BudgetCheckRequestSchema.safeParse({ ...base, [field]: "1" }).success).toBe(true);
      expect(BudgetCheckRequestSchema.safeParse({ ...base, [field]: "2" }).success).toBe(false);
    }
  });
});

describe("budget directives", () => {
  const response = {
    allowed: true,
    remaining_budget: 1,
    mode: "hard_deny",
    budget_limit: 1,
    current_usage: 0,
    project_id: "p",
  };

  it("parses strict versioned directives and rejects drift", () => {
    expect(
      BudgetCheckResponseSchema.safeParse({
        ...response,
        failover_directive: { version: "1", failover_tuning_allowed: true },
        run_control: {
          version: "1",
          action: "terminate",
          agent_run_id: "a".repeat(256),
          reason: "budget_exhausted",
        },
      }).success,
    ).toBe(true);
    for (const runControl of [
      { version: "2", action: "terminate", agent_run_id: "run", reason: "reason" },
      { version: "1", action: "continue", agent_run_id: "run", reason: "reason" },
      { version: "1", action: "terminate", agent_run_id: "run" },
      { version: "1", action: "terminate", agent_run_id: "run", reason: "reason", extra: true },
    ]) {
      expect(
        BudgetCheckResponseSchema.safeParse({ ...response, run_control: runControl }).success,
      ).toBe(false);
    }
    expect(
      BudgetCheckResponseSchema.safeParse({
        ...response,
        failover_directive: { version: "2", failover_tuning_allowed: true },
      }).success,
    ).toBe(false);
    for (const failoverDirective of [
      { version: "1" },
      { version: "1", failover_tuning_allowed: true, extra: true },
    ]) {
      expect(
        BudgetCheckResponseSchema.safeParse({
          ...response,
          failover_directive: failoverDirective,
        }).success,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Modality + media usage.
// ---------------------------------------------------------------------------

describe("modality and media usage", () => {
  it("defaults modality to text in every serialized request/event shape", () => {
    const check = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      model: "gpt-4o",
      provider: "openai",
    }) as Record<string, unknown>;
    const confirm = BudgetConfirmRequestSchema.parse(minimalConfirm());
    const metadata = MetadataEventSchema.parse(minimalMetadataEvent());

    expect(check["modality"]).toBe("text");
    expect(serializeBudgetConfirmRequest(confirm as BudgetConfirmRequest)["modality"]).toBe("text");
    expect(serializeMetadataEvent(metadata as MetadataEvent)["modality"]).toBe("text");
  });

  it("omits estimated_media for a text check and includes it for an image check", () => {
    const textCheck = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 10,
      estimated_media: null,
      model: "gpt-4o",
      provider: "openai",
    }) as Record<string, unknown>;
    const imageCheck = BudgetCheckRequestSchema.parse({
      estimated_input_tokens: 0,
      estimated_media: { image_count: null, quality: null },
      modality: "image",
      model: "gpt-image-1",
      provider: "openai",
    }) as Record<string, unknown>;

    expect(textCheck).not.toHaveProperty("estimated_media");
    expect(imageCheck["modality"]).toBe("image");
    expect(imageCheck["estimated_media"]).toMatchObject({ image_count: null, quality: null });
  });

  it("omits null media_usage from confirm and metadata", () => {
    const confirm = BudgetConfirmRequestSchema.parse(minimalConfirm({ media_usage: null }));
    const metadata = MetadataEventSchema.parse(minimalMetadataEvent({ media_usage: null }));

    expect(serializeBudgetConfirmRequest(confirm as BudgetConfirmRequest)).not.toHaveProperty(
      "media_usage",
    );
    expect(serializeMetadataEvent(metadata as MetadataEvent)).not.toHaveProperty("media_usage");
  });

  it("includes populated media_usage in confirm and metadata", () => {
    const mediaUsage = { image_count: 1, generation_count: 2, resolution: "1024x1024" };
    const confirm = BudgetConfirmRequestSchema.parse(minimalConfirm({ media_usage: mediaUsage }));
    const metadata = MetadataEventSchema.parse(minimalMetadataEvent({ media_usage: mediaUsage }));

    expect(serializeBudgetConfirmRequest(confirm as BudgetConfirmRequest)["media_usage"]).toEqual({
      ...mediaUsage,
      is_estimated: false,
    });
    expect(serializeMetadataEvent(metadata as MetadataEvent)["media_usage"]).toEqual({
      ...mediaUsage,
      is_estimated: false,
    });
  });

  it("retains explicit nested null fields in present media usage", () => {
    const mediaUsage = { image_count: null, resolution: null };
    const confirm = BudgetConfirmRequestSchema.parse(minimalConfirm({ media_usage: mediaUsage }));
    const metadata = MetadataEventSchema.parse(minimalMetadataEvent({ media_usage: mediaUsage }));

    expect(serializeBudgetConfirmRequest(confirm as BudgetConfirmRequest)["media_usage"]).toEqual(
      expect.objectContaining(mediaUsage),
    );
    expect(serializeMetadataEvent(metadata as MetadataEvent)["media_usage"]).toEqual(
      expect.objectContaining(mediaUsage),
    );
  });
});

// ---------------------------------------------------------------------------
// ServiceTier: strict on confirm, free string on metadata.
// ---------------------------------------------------------------------------

describe("service_tier — value-strict on confirm, free string on metadata", () => {
  it.each([
    "auto",
    "default",
    "flex",
    "scale",
    "priority",
    "standard",
    "optimized",
  ])("BudgetConfirmRequest accepts the pinned tier %s", (tier) => {
    expect(
      BudgetConfirmRequestSchema.safeParse(minimalConfirm({ service_tier: tier })).success,
    ).toBe(true);
  });

  it("BudgetConfirmRequest rejects an unknown tier value", () => {
    expect(
      BudgetConfirmRequestSchema.safeParse(minimalConfirm({ service_tier: "hyperspeed" })).success,
    ).toBe(false);
  });

  it("MetadataEvent accepts an arbitrary (bounded) tier string", () => {
    expect(
      MetadataEventSchema.safeParse(minimalMetadataEvent({ service_tier: "hyperspeed" })).success,
    ).toBe(true);
    // but still bounded at 32 chars
    expect(
      MetadataEventSchema.safeParse(minimalMetadataEvent({ service_tier: "x".repeat(33) })).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// price_hints keys remain unrestricted.
// ---------------------------------------------------------------------------

describe("price_hints (D7)", () => {
  it("accepts unknown provider-name keys without failing validation", () => {
    const parsed = BudgetCheckResponseSchema.safeParse({
      allowed: true,
      remaining_budget: 1,
      mode: "hard_deny",
      budget_limit: 1,
      current_usage: 0,
      project_id: "p",
      price_hints: { openai: 1.0, some_brand_new_provider: 2.5 },
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Serialization quirks (None-skipping).
// ---------------------------------------------------------------------------

describe("omitNullish", () => {
  it("drops null/undefined but keeps false/0/empty-string", () => {
    expect(omitNullish({ a: null, b: undefined, c: false, d: 0, e: "" })).toEqual({
      c: false,
      d: 0,
      e: "",
    });
  });
});

describe("serializeMetadataEvent", () => {
  it("drops null optional fields but keeps is_provider_fallback:false, attempt_index:0, call_id", () => {
    const event = MetadataEventSchema.parse(minimalMetadataEvent());
    const wire = serializeMetadataEvent(event as MetadataEvent);
    expect(wire).not.toHaveProperty("requested_provider");
    expect(wire).not.toHaveProperty("requested_model");
    expect(wire).not.toHaveProperty("failover_reason");
    expect(wire).not.toHaveProperty("possibly_succeeded");
    expect(wire).not.toHaveProperty("provider_region");
    expect(wire["is_provider_fallback"]).toBe(false);
    expect(wire["attempt_index"]).toBe(0);
    expect(wire).toHaveProperty("call_id");
  });

  it("serializes populated failover fields as plain enum string values", () => {
    const event = MetadataEventSchema.parse(
      minimalMetadataEvent({
        is_provider_fallback: true,
        requested_provider: "openai",
        failover_reason: "primary_error",
        possibly_succeeded: true,
      }),
    );
    const wire = serializeMetadataEvent(event as MetadataEvent);
    expect(wire["requested_provider"]).toBe("openai");
    expect(wire["failover_reason"]).toBe("primary_error");
    expect(wire["possibly_succeeded"]).toBe(true);
  });

  it("embeds token_details via the omit-is_estimated-when-false rule", () => {
    const event = MetadataEventSchema.parse(
      minimalMetadataEvent({ token_details: createTokenDetails({ input_tokens: 3 }) }),
    );
    const wire = serializeMetadataEvent(event as MetadataEvent);
    const td = wire["token_details"] as Record<string, unknown>;
    expect(td["input_tokens"]).toBe(3);
    expect(td).not.toHaveProperty("is_estimated");
  });

  it("omits token_details entirely when null", () => {
    const event = MetadataEventSchema.parse(minimalMetadataEvent({ token_details: null }));
    const wire = serializeMetadataEvent(event as MetadataEvent);
    expect(wire).not.toHaveProperty("token_details");
  });

  it("omits nullish receipt fields but rejects a pricing basis without an aggregate count", () => {
    const withNullReceipts = MetadataEventSchema.parse(
      minimalMetadataEvent({
        parent_agent_run_id: null,
        tags: null,
        deny_source: null,
        deny_reason: null,
        denied_by_period: null,
        estimated_output_bound: null,
        velocity_flags: null,
        receipt_aggregate_count: null,
        receipt_pricing_input_tokens: null,
      }),
    );
    const wire = serializeMetadataEvent(withNullReceipts as MetadataEvent);
    for (const key of [
      "parent_agent_run_id",
      "tags",
      "deny_source",
      "deny_reason",
      "denied_by_period",
      "estimated_output_bound",
      "velocity_flags",
      "receipt_aggregate_count",
      "receipt_pricing_input_tokens",
    ]) {
      expect(wire).not.toHaveProperty(key);
    }
    const withoutCount = minimalMetadataEvent({ receipt_pricing_input_tokens: 10 });
    expect(MetadataEventSchema.safeParse(withoutCount).success).toBe(false);
    expect(() => serializeMetadataEvent(withoutCount as unknown as MetadataEvent)).toThrow(
      ConfigurationError,
    );
  });

  it("preserves populated parent, tags, and denial-receipt fields on the wire", () => {
    const event = MetadataEventSchema.parse(
      minimalMetadataEvent({
        parent_agent_run_id: "run-parent",
        tags: { team: "platform", empty: "" },
        deny_source: "aggregate_replay",
        deny_reason: "rate_acceleration",
        denied_by_period: "daily",
        estimated_output_bound: 4096,
        velocity_flags: ["repeat_size", "rate_acceleration"],
        receipt_aggregate_count: 3,
        receipt_pricing_input_tokens: 128,
      }),
    );
    const wire = serializeMetadataEvent(event as MetadataEvent);

    expect({
      parent_agent_run_id: wire["parent_agent_run_id"],
      tags: wire["tags"],
      deny_source: wire["deny_source"],
      deny_reason: wire["deny_reason"],
      denied_by_period: wire["denied_by_period"],
      estimated_output_bound: wire["estimated_output_bound"],
      velocity_flags: wire["velocity_flags"],
      receipt_aggregate_count: wire["receipt_aggregate_count"],
      receipt_pricing_input_tokens: wire["receipt_pricing_input_tokens"],
    }).toEqual({
      parent_agent_run_id: "run-parent",
      tags: { team: "platform", empty: "" },
      deny_source: "aggregate_replay",
      deny_reason: "rate_acceleration",
      denied_by_period: "daily",
      estimated_output_bound: 4096,
      velocity_flags: ["repeat_size", "rate_acceleration"],
      receipt_aggregate_count: 3,
      receipt_pricing_input_tokens: 128,
    });
  });

  it("validates receipt fields and metadata tags at their inclusive bounds", () => {
    const valid = minimalMetadataEvent({
      parent_agent_run_id: "a".repeat(256),
      tags: { ["k".repeat(64)]: "v".repeat(256), empty: "" },
      deny_source: "aggregate_replay",
      deny_reason: "r".repeat(64),
      denied_by_period: "p".repeat(32),
      estimated_output_bound: 100_000_000,
      velocity_flags: Array.from({ length: 8 }, () => "repeat_size"),
      receipt_aggregate_count: 100_000_000,
      receipt_pricing_input_tokens: 100_000_000,
    });
    expect(MetadataEventSchema.safeParse(valid).success).toBe(true);
    for (const overrides of [
      { parent_agent_run_id: "a".repeat(257) },
      { tags: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`k${index}`, "v"])) },
      { deny_source: "unknown" },
      { deny_reason: "r".repeat(65) },
      { denied_by_period: "p".repeat(33) },
      { estimated_output_bound: 100_000_001 },
      { velocity_flags: Array.from({ length: 9 }, () => "repeat_size") },
      { velocity_flags: ["unknown"] },
      { receipt_aggregate_count: 0 },
      { receipt_pricing_input_tokens: 100_000_001 },
    ]) {
      expect(MetadataEventSchema.safeParse(minimalMetadataEvent(overrides)).success).toBe(false);
    }
  });
});

describe("serializeBudgetConfirmRequest", () => {
  it("preserves the exact legacy reservation-settled wire object", () => {
    const confirm = BudgetConfirmRequestSchema.parse(minimalConfirm());
    const wire = serializeBudgetConfirmRequest(confirm as BudgetConfirmRequest);

    expect(wire).toEqual({
      reservation_id: "res-1",
      model: "gpt-4o",
      provider: "openai",
      modality: "text",
      is_provider_fallback: false,
      call_id: "11111111-1111-1111-1111-111111111111",
      token_details: {
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 0,
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        reasoning_tokens: 0,
        audio_input_tokens: 0,
        audio_output_tokens: 0,
        image_input_tokens: 0,
        image_output_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
        tool_use_input_tokens: 0,
      },
    });
  });

  it("includes provider_region and service_tier when set", () => {
    const confirm = BudgetConfirmRequestSchema.parse(
      minimalConfirm({ provider_region: "us-east-1", service_tier: "flex" }),
    );
    const wire = serializeBudgetConfirmRequest(confirm as BudgetConfirmRequest);
    expect(wire["provider_region"]).toBe("us-east-1");
    expect(wire["service_tier"]).toBe("flex");
  });

  it("call_id round-trips exactly through serialization", () => {
    const confirm = BudgetConfirmRequestSchema.parse(minimalConfirm());
    const wire = serializeBudgetConfirmRequest(confirm as BudgetConfirmRequest);
    expect(wire["call_id"]).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("BudgetConfirmRequest funding source", () => {
  it("requires exactly one reservation or lease and omits the unset funding key", () => {
    const reservation = BudgetConfirmRequestSchema.parse(minimalConfirm());
    const lease = BudgetConfirmRequestSchema.parse(
      minimalConfirm({ reservation_id: null, lease_id: "lease-1" }),
    );
    expect(serializeBudgetConfirmRequest(reservation as BudgetConfirmRequest)).not.toHaveProperty(
      "lease_id",
    );
    const leaseWire = serializeBudgetConfirmRequest(lease as BudgetConfirmRequest);
    expect(leaseWire["lease_id"]).toBe("lease-1");
    expect(leaseWire).not.toHaveProperty("reservation_id");
    expect(
      BudgetConfirmRequestSchema.safeParse(minimalConfirm({ lease_id: "lease-1" })).success,
    ).toBe(false);
    expect(
      BudgetConfirmRequestSchema.safeParse(minimalConfirm({ reservation_id: null, lease_id: null }))
        .success,
    ).toBe(false);
    expect(
      BudgetConfirmRequestSchema.safeParse(minimalConfirm({ lease_id: "lease-1".padEnd(65, "x") }))
        .success,
    ).toBe(false);
  });
});

describe("new ingest rejection codes", () => {
  it("parses a 202 disposition containing either tag rejection code", () => {
    for (const code of ["invalid_tags", "tag_cardinality_exceeded"]) {
      expect(
        validation.IngestResponseSchema.safeParse({
          ingested: 0,
          rejected: [{ index: 0, code, model: "gpt-4o", message: "rejected" }],
        }).success,
      ).toBe(true);
    }
  });
});

describe("MediaUsage maximum bounds", () => {
  it("accepts 100,000,000 and rejects 100,000,001 while preserving number vs integer fields", () => {
    for (const field of [
      "audio_seconds",
      "video_seconds",
      "image_count",
      "generation_count",
      "input_characters",
    ] as const) {
      expect(MediaUsageSchema.safeParse({ [field]: 100_000_000 }).success).toBe(true);
      expect(MediaUsageSchema.safeParse({ [field]: 100_000_001 }).success).toBe(false);
    }
    expect(MediaUsageSchema.safeParse({ audio_seconds: 0.5 }).success).toBe(true);
    expect(MediaUsageSchema.safeParse({ image_count: 0.5 }).success).toBe(false);
  });
});

type RuntimeSchema = {
  parse(input: unknown): unknown;
  safeParse(input: unknown): { success: boolean };
};

function runtimeSchema(name: string): RuntimeSchema | undefined {
  return (validation as unknown as Record<string, RuntimeSchema | undefined>)[name];
}

function minimalUntrackedReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openai",
    client_shape: "openai_sdk",
    mode: "sync",
    surface: "chat.completions.create",
    rule_kind: "unmetered_spend",
    posture: "warn",
    occurrences: 1,
    first_seen_at: "2026-08-31T01:00:00Z",
    last_seen_at: "2026-08-31T01:00:01Z",
    sdk_instance_id: "sdk-instance-1",
    report_id: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

describe("testing-plane wire models", () => {
  it("validates the exact strict UntrackedSurfaceReport shape and optional capability scope", () => {
    const schema = runtimeSchema("UntrackedSurfaceReportSchema");
    expect(schema).toBeDefined();
    if (!schema) return;

    expect(schema.safeParse(minimalUntrackedReport()).success).toBe(true);
    expect(
      schema.safeParse(minimalUntrackedReport({ capability_scope: "raw_response" })).success,
    ).toBe(true);
    expect(schema.safeParse(minimalUntrackedReport({ capability_scope: null })).success).toBe(true);
    expect(schema.safeParse(minimalUntrackedReport({ extra: true })).success).toBe(false);

    for (const required of [
      "provider",
      "client_shape",
      "mode",
      "surface",
      "rule_kind",
      "posture",
      "occurrences",
      "first_seen_at",
      "last_seen_at",
      "sdk_instance_id",
      "report_id",
    ]) {
      const input = minimalUntrackedReport();
      delete input[required];
      expect(schema.safeParse(input).success, `${required} must be required`).toBe(false);
    }
  });

  it("enforces untracked vocabularies, string bounds, occurrence bounds, UUID, and date order", () => {
    const schema = runtimeSchema("UntrackedSurfaceReportSchema");
    expect(schema).toBeDefined();
    if (!schema) return;

    for (const overrides of [
      { provider: "not-a-provider" },
      { client_shape: "unknown" },
      { mode: "parallel" },
      { surface: "bad-surface" },
      { surface: "x".repeat(129) },
      { rule_kind: "priced" },
      { capability_scope: "prompt" },
      { posture: "deny" },
      { occurrences: 0 },
      { occurrences: 1_000_000_001 },
      { occurrences: 1.5 },
      { sdk_instance_id: "x".repeat(101) },
      { report_id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
      { first_seen_at: "not-a-date" },
      { last_seen_at: "2026-08-31T00:59:59Z" },
    ]) {
      expect(
        schema.safeParse(minimalUntrackedReport(overrides)).success,
        JSON.stringify(overrides),
      ).toBe(false);
    }
  });

  it("orders RFC3339 instants without truncating sub-millisecond precision", () => {
    const schema = runtimeSchema("UntrackedSurfaceReportSchema");
    expect(schema).toBeDefined();
    if (!schema) return;

    expect(
      schema.safeParse(
        minimalUntrackedReport({
          first_seen_at: "2026-08-31T01:00:00.000200Z",
          last_seen_at: "2026-08-31T01:00:00.000100Z",
        }),
      ).success,
    ).toBe(false);
    expect(
      schema.safeParse(
        minimalUntrackedReport({
          first_seen_at: "2026-08-31T01:00:00.000200Z",
          last_seen_at: "2026-08-31T01:00:00.000200Z",
        }),
      ).success,
    ).toBe(true);
    expect(
      schema.safeParse(
        minimalUntrackedReport({
          first_seen_at: "2026-08-31T02:00:00.123456+01:00",
          last_seen_at: "2026-08-31T01:00:00.123456Z",
        }),
      ).success,
    ).toBe(true);
  });

  it("validates accepted receipts without fabricating omitted breaker fields", () => {
    const untrackedAccepted = runtimeSchema("UntrackedSurfaceAcceptedSchema");
    const breakerAccepted = runtimeSchema("BreakerReportAcceptedSchema");
    expect(untrackedAccepted).toBeDefined();
    expect(breakerAccepted).toBeDefined();
    if (!untrackedAccepted || !breakerAccepted) return;

    expect(untrackedAccepted.safeParse({ accepted: 0 }).success).toBe(true);
    expect(untrackedAccepted.safeParse({ accepted: -1 }).success).toBe(false);
    expect(untrackedAccepted.safeParse({ accepted: 0.5 }).success).toBe(false);
    expect(untrackedAccepted.safeParse({}).success).toBe(false);
    expect(untrackedAccepted.safeParse({ accepted: 1, extra: true }).success).toBe(false);

    expect(breakerAccepted.parse({})).toEqual({});
    expect(breakerAccepted.safeParse({ accepted: true }).success).toBe(true);
    expect(breakerAccepted.safeParse({ accepted: "true" }).success).toBe(false);
    expect(breakerAccepted.safeParse({ accepted: true, extra: true }).success).toBe(false);
  });

  it("validates the exact strict BreakerStateReport shape", () => {
    const schema = runtimeSchema("BreakerStateReportSchema");
    expect(schema).toBeDefined();
    if (!schema) return;
    const valid = {
      provider: "openai",
      state: "half_open",
      failure_count: 0,
      success_count: 2,
      reported_at: "2026-08-31T01:00:00+00:00",
      sdk_instance_id: "sdk-instance-1",
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, extra: true }).success).toBe(false);
    for (const required of Object.keys(valid)) {
      const input: Record<string, unknown> = { ...valid };
      delete input[required];
      expect(schema.safeParse(input).success, `${required} must be required`).toBe(false);
    }
    for (const overrides of [
      { provider: "unknown" },
      { state: "half-open" },
      { failure_count: -1 },
      { failure_count: 0.5 },
      { success_count: -1 },
      { reported_at: "yesterday" },
      { sdk_instance_id: "x".repeat(101) },
    ]) {
      expect(schema.safeParse({ ...valid, ...overrides }).success, JSON.stringify(overrides)).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function minimalMetadataEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 123,
    status: "success",
    is_model_fallback: false,
    call_id: "11111111-1111-1111-1111-111111111111",
    sdk_instance_id: "sdk-1",
    timestamp: "2026-07-03T00:00:00Z",
    ...overrides,
  };
}

function minimalConfirm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reservation_id: "res-1",
    model: "gpt-4o",
    provider: "openai",
    call_id: "11111111-1111-1111-1111-111111111111",
    token_details: createTokenDetails({ input_tokens: 10, output_tokens: 5 }),
    ...overrides,
  };
}
