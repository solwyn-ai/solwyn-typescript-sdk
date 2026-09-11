/**
 * Contract-fidelity: the zod schemas in `src/validation.ts` must match the checked-in
 * OpenAPI snapshot at `tests/fixtures/openapi.snapshot.json`.
 *
 * Drift between validation.ts and the snapshot fails a test here, not production.
 * Every required field in the spec's component schemas is required in the zod
 * schema; optionality and string/number constraints match. Enumerated contract values are
 * asserted explicitly. The deliberate allowance for unrestricted `price_hints` keys is pinned.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOKEN_DETAILS_COUNTERS, TokenDetailsSchema } from "../../src/token-details";
import {
  BreakerReportAcceptedSchema,
  BreakerStateReportSchema,
  BudgetCheckRequestObjectSchema,
  BudgetCheckResponseSchema,
  BudgetConfirmRequestObjectSchema,
  BudgetModeSchema,
  CallStatusSchema,
  CircuitStateSchema,
  FailoverDirectiveSchema,
  FailoverReasonSchema,
  IngestRejectionCodeSchema,
  IngestRejectionSchema,
  IngestResponseSchema,
  LeaseGrantRequestObjectSchema,
  LeaseGrantResponseSchema,
  LeasePostureSchema,
  LeaseRenewRequestObjectSchema,
  LeaseSurrenderRequestObjectSchema,
  LeaseSurrenderResponseSchema,
  MediaUsageSchema,
  MetadataEventSchema,
  ModalitySchema,
  ProviderNameSchema,
  RateLimitErrorResponseSchema,
  RunControlDirectiveSchema,
  ServiceTierSchema,
  UntrackedSurfaceAcceptedSchema,
  UntrackedSurfaceReportObjectSchema,
} from "../../src/validation";

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  pattern?: string;
  const?: string;
}

const snapshotPath = fileURLToPath(new URL("../fixtures/openapi.snapshot.json", import.meta.url));
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
  components: { schemas: Record<string, JsonSchema> };
};
const schemas = snapshot.components.schemas;
const BudgetConfirmRequestIntrospectionSchema = BudgetConfirmRequestObjectSchema;

function specSchema(name: string): JsonSchema {
  const s = schemas[name];
  if (!s) {
    throw new Error(`snapshot is missing schema ${name}`);
  }
  return s;
}

/** Find a constraint key on a property schema, unwrapping a nullable `anyOf` if present. */
function findConstraint(prop: JsonSchema | undefined, key: keyof JsonSchema): unknown {
  if (!prop) {
    return undefined;
  }
  if (prop[key] !== undefined) {
    return prop[key];
  }
  for (const sub of prop.anyOf ?? []) {
    if (sub[key] !== undefined) {
      return sub[key];
    }
  }
  return undefined;
}

// Non-refined object schemas, so `.shape` is introspectable.
const wireSchemas = [
  { name: "BudgetCheckRequest", schema: BudgetCheckRequestObjectSchema },
  { name: "BudgetCheckResponse", schema: BudgetCheckResponseSchema },
  { name: "BudgetConfirmRequest", schema: BudgetConfirmRequestIntrospectionSchema },
  { name: "LeaseGrantRequest", schema: LeaseGrantRequestObjectSchema },
  { name: "LeaseGrantResponse", schema: LeaseGrantResponseSchema },
  { name: "LeasePosture", schema: LeasePostureSchema },
  { name: "LeaseRenewRequest", schema: LeaseRenewRequestObjectSchema },
  { name: "LeaseSurrenderRequest", schema: LeaseSurrenderRequestObjectSchema },
  { name: "LeaseSurrenderResponse", schema: LeaseSurrenderResponseSchema },
  // The public SDK type is MetadataEvent; the server component was renamed.
  { name: "IngestMetadataEvent", schema: MetadataEventSchema },
  { name: "FailoverDirective", schema: FailoverDirectiveSchema },
  { name: "RunControlDirective", schema: RunControlDirectiveSchema },
  { name: "TokenDetails", schema: TokenDetailsSchema },
  { name: "MediaUsage", schema: MediaUsageSchema },
  { name: "IngestResponse", schema: IngestResponseSchema },
  { name: "IngestRejection", schema: IngestRejectionSchema },
  { name: "RateLimitErrorResponse", schema: RateLimitErrorResponseSchema },
  { name: "UntrackedSurfaceReport", schema: UntrackedSurfaceReportObjectSchema },
  { name: "UntrackedSurfaceAccepted", schema: UntrackedSurfaceAcceptedSchema },
  { name: "BreakerStateReport", schema: BreakerStateReportSchema },
  { name: "BreakerReportAccepted", schema: BreakerReportAcceptedSchema },
] as const;

describe("field-set parity with the OpenAPI snapshot", () => {
  for (const { name, schema } of wireSchemas) {
    it(`${name}: property key set matches the spec`, () => {
      const zodKeys = Object.keys(schema.shape).sort();
      const specKeys = Object.keys(specSchema(name).properties ?? {}).sort();
      expect(zodKeys).toEqual(specKeys);
    });

    it(`${name}: required-field set matches the spec (optionality parity)`, () => {
      const zodRequired = Object.entries(schema.shape)
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([key]) => key)
        .sort();
      const specRequired = [...(specSchema(name).required ?? [])].sort();
      expect(zodRequired).toEqual(specRequired);
    });
  }
});

describe("enum value sets match the spec", () => {
  const enumCases = [
    { name: "ProviderName", options: ProviderNameSchema.options },
    { name: "BudgetMode", options: BudgetModeSchema.options },
    { name: "CallStatus", options: CallStatusSchema.options },
    { name: "FailoverReason", options: FailoverReasonSchema.options },
    { name: "IngestRejectionCode", options: IngestRejectionCodeSchema.options },
    { name: "CircuitState", options: CircuitStateSchema.options },
  ];

  for (const { name, options } of enumCases) {
    it(`${name}`, () => {
      const specEnum = [...(specSchema(name).enum ?? [])].sort();
      expect([...options].sort()).toEqual(specEnum);
    });
  }

  it("Modality matches every inline request/event enum", () => {
    const expected = [...ModalitySchema.options].sort();
    for (const schemaName of [
      "BudgetCheckRequest",
      "BudgetConfirmRequest",
      "IngestMetadataEvent",
    ]) {
      const specEnum = findConstraint(specSchema(schemaName).properties?.["modality"], "enum") as
        | string[]
        | undefined;
      expect([...(specEnum ?? [])].sort()).toEqual(expected);
    }
  });

  it("ServiceTier matches the BudgetConfirmRequest.service_tier enum", () => {
    const specTier = findConstraint(
      specSchema("BudgetConfirmRequest").properties?.["service_tier"],
      "enum",
    ) as string[];
    expect([...ServiceTierSchema.options].sort()).toEqual([...specTier].sort());
  });

  for (const field of [
    "client_shape",
    "mode",
    "rule_kind",
    "capability_scope",
    "posture",
  ] as const) {
    it(`UntrackedSurfaceReport.${field} matches its inline closed vocabulary`, () => {
      const specOptions = findConstraint(
        specSchema("UntrackedSurfaceReport").properties?.[field],
        "enum",
      ) as string[];
      const zodField = UntrackedSurfaceReportObjectSchema.shape[field] as unknown as {
        isOptional(): boolean;
        options?: readonly string[];
        unwrap?: () => unknown;
      };
      const zodOptions = (zodField.isOptional() ? zodField.unwrap?.() : zodField) as {
        options?: readonly string[];
        unwrap?: () => { options: readonly string[] };
      };
      const options = zodOptions.options ?? zodOptions.unwrap?.().options;
      expect([...(options ?? [])].sort()).toEqual([...specOptions].sort());
    });
  }
});

describe("testing-plane schema constraints match the snapshot", () => {
  it("pins UntrackedSurfaceReport string, numeric, and UUID constraints", () => {
    const spec = specSchema("UntrackedSurfaceReport").properties ?? {};
    expect(spec["surface"]?.maxLength).toBe(128);
    expect(spec["surface"]?.pattern).toBe(
      "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*){0,7}$",
    );
    expect(spec["occurrences"]?.minimum).toBe(1);
    expect(spec["occurrences"]?.maximum).toBe(1_000_000_000);
    expect(spec["sdk_instance_id"]?.maxLength).toBe(100);
    expect(spec["report_id"]?.maxLength).toBe(36);
    expect(spec["report_id"]?.pattern).toBe(
      "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    );

    expect(UntrackedSurfaceReportObjectSchema.shape.surface.safeParse("a.b_c9").success).toBe(true);
    expect(UntrackedSurfaceReportObjectSchema.shape.surface.safeParse("a-b").success).toBe(false);
    expect(UntrackedSurfaceReportObjectSchema.shape.occurrences.safeParse(1).success).toBe(true);
    expect(
      UntrackedSurfaceReportObjectSchema.shape.occurrences.safeParse(1_000_000_001).success,
    ).toBe(false);
  });

  it("pins advisory accepted/count constraints", () => {
    expect(specSchema("UntrackedSurfaceAccepted").properties?.["accepted"]?.minimum).toBe(0);
    for (const field of ["failure_count", "success_count"] as const) {
      expect(specSchema("BreakerStateReport").properties?.[field]?.minimum).toBe(0);
      expect(BreakerStateReportSchema.shape[field].safeParse(-1).success).toBe(false);
      expect(BreakerStateReportSchema.shape[field].safeParse(0.5).success).toBe(false);
    }
    expect(specSchema("BreakerStateReport").properties?.["sdk_instance_id"]?.maxLength).toBe(100);
    expect(BreakerReportAcceptedSchema.parse({})).toEqual({});
  });
});

describe("D1: call_id maxLength 36", () => {
  it("spec pins a lowercase canonical UUID and the zod schemas enforce it", () => {
    expect(
      findConstraint(specSchema("IngestMetadataEvent").properties?.["call_id"], "maxLength"),
    ).toBe(36);
    expect(
      findConstraint(specSchema("BudgetConfirmRequest").properties?.["call_id"], "maxLength"),
    ).toBe(36);
    expect(
      findConstraint(specSchema("IngestMetadataEvent").properties?.["call_id"], "pattern"),
    ).toBe("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    expect(
      MetadataEventSchema.shape.call_id.safeParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").success,
    ).toBe(true);
    expect(MetadataEventSchema.shape.call_id.safeParse("x".repeat(37)).success).toBe(false);
    expect(
      BudgetConfirmRequestIntrospectionSchema.shape.call_id.safeParse("x".repeat(37)).success,
    ).toBe(false);
  });
});

describe("D1: TokenDetails numeric bounds 0..100_000_000", () => {
  for (const counter of TOKEN_DETAILS_COUNTERS) {
    it(`${counter}: spec bounds match and zod enforces them`, () => {
      const prop = specSchema("TokenDetails").properties?.[counter];
      expect(prop?.minimum).toBe(0);
      expect(prop?.maximum).toBe(100_000_000);
      const field = TokenDetailsSchema.shape[counter];
      expect(field.safeParse(100_000_000).success).toBe(true);
      expect(field.safeParse(100_000_001).success).toBe(false);
      expect(field.safeParse(-1).success).toBe(false);
    });
  }
});

describe("MediaUsage bounds", () => {
  const integerFields = ["image_count", "generation_count", "input_characters"] as const;
  const numericFields = ["video_seconds", "audio_seconds"] as const;
  const stringFields = ["resolution", "quality"] as const;

  for (const fieldName of integerFields) {
    it(`${fieldName}: spec minimum matches and zod enforces non-negative integers`, () => {
      const specField = specSchema("MediaUsage").properties?.[fieldName];
      expect(findConstraint(specField, "minimum")).toBe(0);
      expect(findConstraint(specField, "maximum")).toBe(100_000_000);
      const field = MediaUsageSchema.shape[fieldName];
      expect(field?.safeParse(0).success).toBe(true);
      expect(field?.safeParse(100_000_000).success).toBe(true);
      expect(field?.safeParse(100_000_001).success).toBe(false);
      expect(field?.safeParse(-1).success).toBe(false);
      expect(field?.safeParse(0.5).success).toBe(false);
    });
  }

  for (const fieldName of numericFields) {
    it(`${fieldName}: spec minimum matches and zod enforces it`, () => {
      const specField = specSchema("MediaUsage").properties?.[fieldName];
      expect(findConstraint(specField, "minimum")).toBe(0);
      expect(findConstraint(specField, "maximum")).toBe(100_000_000);
      const field = MediaUsageSchema.shape[fieldName];
      expect(field?.safeParse(0.5).success).toBe(true);
      expect(field?.safeParse(100_000_000).success).toBe(true);
      expect(field?.safeParse(100_000_001).success).toBe(false);
      expect(field?.safeParse(-1).success).toBe(false);
    });
  }

  for (const fieldName of stringFields) {
    it(`${fieldName}: spec maxLength matches and zod enforces it`, () => {
      const specField = specSchema("MediaUsage").properties?.[fieldName];
      expect(findConstraint(specField, "maxLength")).toBe(32);
      const field = MediaUsageSchema.shape[fieldName];
      expect(field?.safeParse("x".repeat(32)).success).toBe(true);
      expect(field?.safeParse("x".repeat(33)).success).toBe(false);
    });
  }
});

describe("D1: failover_error_class maxLength 64 + pattern", () => {
  it("spec pins maxLength and pattern, zod enforces both", () => {
    const prop = specSchema("IngestMetadataEvent").properties?.["failover_error_class"];
    expect(findConstraint(prop, "maxLength")).toBe(64);
    expect(findConstraint(prop, "pattern")).toBe("^[A-Za-z][A-Za-z0-9_.]*$");
    const field = MetadataEventSchema.shape.failover_error_class;
    expect(field.safeParse("RateLimitError").success).toBe(true);
    expect(field.safeParse("leaked secret message").success).toBe(false);
    expect(field.safeParse(`E${"a".repeat(64)}`).success).toBe(false);
  });
});

describe("model-name fields bounded at 2048 (Bedrock ARN sizing)", () => {
  it("spec pins 2048 on model fields and fallback_models element", () => {
    expect(
      findConstraint(specSchema("IngestMetadataEvent").properties?.["model"], "maxLength"),
    ).toBe(2048);
    expect(
      findConstraint(
        specSchema("IngestMetadataEvent").properties?.["requested_model"],
        "maxLength",
      ),
    ).toBe(2048);
    expect(
      findConstraint(specSchema("BudgetCheckRequest").properties?.["model"], "maxLength"),
    ).toBe(2048);
    const fallback = specSchema("BudgetCheckRequest").properties?.["fallback_models"];
    expect(fallback?.maxItems).toBe(8);
    expect(fallback?.items?.maxLength).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// Pin the zod-side maxLength on every bounded string field, not just the
// spec snapshot. Each bound is READ FROM the snapshot (spec-derived, never a hard-
// coded literal in the assertion) and then boundary-checked against the actual zod
// field: a value AT the bound must parse, a value ONE OVER must not. This fails the
// moment someone drops a `.max(...)` from validation.ts, catching wire-contract drift
// (an oversized model 422s whole ingest batches) locally instead of at the server.
// ---------------------------------------------------------------------------

describe("zod schemas enforce the spec's string maxLength bounds (F6)", () => {
  /** Read the spec's declared maxLength for a property, unwrapping a nullable anyOf. */
  function specMaxLength(schemaName: string, field: string): number {
    const bound = findConstraint(specSchema(schemaName).properties?.[field], "maxLength");
    if (typeof bound !== "number") {
      throw new Error(`snapshot ${schemaName}.${field} has no maxLength to derive from`);
    }
    return bound;
  }

  // Each case names the wire schema, the field, and the zod field schema to probe.
  const stringFieldCases = [
    { schemaName: "IngestMetadataEvent", field: "model", zod: MetadataEventSchema.shape.model },
    {
      schemaName: "IngestMetadataEvent",
      field: "requested_model",
      zod: MetadataEventSchema.shape.requested_model,
    },
    {
      schemaName: "IngestMetadataEvent",
      field: "agent_run_id",
      zod: MetadataEventSchema.shape.agent_run_id,
    },
    {
      schemaName: "IngestMetadataEvent",
      field: "parent_agent_run_id",
      zod: MetadataEventSchema.shape.parent_agent_run_id,
    },
    {
      schemaName: "IngestMetadataEvent",
      field: "agent_run_name",
      zod: MetadataEventSchema.shape.agent_run_name,
    },
    {
      schemaName: "IngestMetadataEvent",
      field: "provider_region",
      zod: MetadataEventSchema.shape.provider_region,
    },
    {
      schemaName: "BudgetConfirmRequest",
      field: "model",
      zod: BudgetConfirmRequestIntrospectionSchema.shape.model,
    },
    {
      schemaName: "BudgetConfirmRequest",
      field: "provider_region",
      zod: BudgetConfirmRequestIntrospectionSchema.shape.provider_region,
    },
    {
      schemaName: "BudgetConfirmRequest",
      field: "lease_id",
      zod: BudgetConfirmRequestIntrospectionSchema.shape.lease_id,
    },
    {
      schemaName: "BudgetCheckRequest",
      field: "model",
      zod: BudgetCheckRequestObjectSchema.shape.model,
    },
    {
      schemaName: "BudgetCheckRequest",
      field: "agent_run_id",
      zod: BudgetCheckRequestObjectSchema.shape.agent_run_id,
    },
    {
      schemaName: "IngestMetadataEvent",
      field: "deny_reason",
      zod: MetadataEventSchema.shape.deny_reason,
    },
    {
      schemaName: "IngestMetadataEvent",
      field: "denied_by_period",
      zod: MetadataEventSchema.shape.denied_by_period,
    },
    {
      schemaName: "RunControlDirective",
      field: "agent_run_id",
      zod: RunControlDirectiveSchema.shape.agent_run_id,
    },
    {
      schemaName: "RunControlDirective",
      field: "reason",
      zod: RunControlDirectiveSchema.shape.reason,
    },
  ] as const;

  for (const { schemaName, field, zod } of stringFieldCases) {
    it(`${schemaName}.${field}: at-bound accepted, one-over rejected`, () => {
      const bound = specMaxLength(schemaName, field);
      expect(zod.safeParse("x".repeat(bound)).success).toBe(true);
      expect(zod.safeParse("x".repeat(bound + 1)).success).toBe(false);
    });
  }

  it("BudgetCheckRequest.fallback_models element: at-bound accepted, one-over rejected", () => {
    const spec = specSchema("BudgetCheckRequest").properties?.["fallback_models"];
    const bound = spec?.items?.maxLength;
    if (typeof bound !== "number") {
      throw new Error("snapshot fallback_models.items has no maxLength to derive from");
    }
    const field = BudgetCheckRequestObjectSchema.shape.fallback_models;
    expect(field.safeParse(["x".repeat(bound)]).success).toBe(true);
    expect(field.safeParse(["x".repeat(bound + 1)]).success).toBe(false);
  });
});

describe("WS0 event receipt fidelity", () => {
  const numericFields = [
    "input_tokens",
    "output_tokens",
    "estimated_output_bound",
    "receipt_aggregate_count",
    "receipt_pricing_input_tokens",
  ] as const;

  for (const fieldName of numericFields) {
    it(`${fieldName}: spec numeric bounds are enforced`, () => {
      const specField = specSchema("IngestMetadataEvent").properties?.[fieldName];
      const minimum = findConstraint(specField, "minimum");
      const maximum = findConstraint(specField, "maximum");
      if (typeof minimum !== "number" || typeof maximum !== "number") {
        throw new Error(`snapshot IngestMetadataEvent.${fieldName} lacks numeric bounds`);
      }
      const field = MetadataEventSchema.shape[fieldName];
      expect(field.safeParse(minimum).success).toBe(true);
      expect(field.safeParse(maximum).success).toBe(true);
      expect(field.safeParse(minimum - 1).success).toBe(false);
      expect(field.safeParse(maximum + 1).success).toBe(false);
    });
  }

  it("deny_source accepts exactly the snapshot's closed enum", () => {
    const options = findConstraint(
      specSchema("IngestMetadataEvent").properties?.["deny_source"],
      "enum",
    );
    if (!Array.isArray(options)) {
      throw new Error("snapshot IngestMetadataEvent.deny_source lacks an enum");
    }
    for (const option of options) {
      expect(MetadataEventSchema.shape.deny_source.safeParse(option).success).toBe(true);
    }
    expect(MetadataEventSchema.shape.deny_source.safeParse("unknown").success).toBe(false);
  });

  it("velocity_flags mirrors the snapshot enum and array cap", () => {
    const specField = specSchema("IngestMetadataEvent").properties?.["velocity_flags"];
    const maxItems = findConstraint(specField, "maxItems");
    const items = findConstraint(specField, "items") as JsonSchema | undefined;
    if (typeof maxItems !== "number" || !items?.enum) {
      throw new Error("snapshot IngestMetadataEvent.velocity_flags lacks enum array constraints");
    }
    for (const option of items.enum) {
      expect(MetadataEventSchema.shape.velocity_flags.safeParse([option]).success).toBe(true);
    }
    expect(
      MetadataEventSchema.shape.velocity_flags.safeParse(
        Array.from({ length: maxItems + 1 }, () => "repeat_size"),
      ).success,
    ).toBe(false);
    expect(MetadataEventSchema.shape.velocity_flags.safeParse(["unknown"]).success).toBe(false);
  });
});

describe("D7: price_hints keys are intentionally unrestricted (deliberate deviation)", () => {
  it("the spec restricts propertyNames to ProviderName, but the SDK accepts any string key", () => {
    // The snapshot restricts price_hints keys to ProviderName...
    const priceHints = specSchema("BudgetCheckResponse").properties?.["price_hints"];
    const hasPropertyNamesRestriction = (priceHints?.anyOf ?? []).some(
      (sub) => "propertyNames" in (sub as Record<string, unknown>),
    );
    expect(hasPropertyNamesRestriction).toBe(true);
    // The zod schema deliberately does not, so unknown providers in hints remain valid.
    const parsed = BudgetCheckResponseSchema.safeParse({
      allowed: true,
      remaining_budget: 1,
      mode: "hard_deny",
      budget_limit: 1,
      current_usage: 0,
      project_id: "p",
      price_hints: { a_brand_new_provider_not_in_the_enum: 3.3 },
    });
    expect(parsed.success).toBe(true);
  });
});
