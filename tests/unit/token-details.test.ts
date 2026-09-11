import { describe, expect, it } from "vitest";
import {
  createTokenDetails,
  serializeTokenDetails,
  TOKEN_DETAILS_COUNTERS,
  TOKEN_DETAILS_MAX,
  TokenDetailsSchema,
  totalTokens,
  zeroTokenDetails,
} from "../../src/token-details";

describe("TokenDetails field set + defaults", () => {
  it("locks the exact 14-field set (13 counters + is_estimated)", () => {
    const keys = Object.keys(TokenDetailsSchema.shape).sort();
    const expected = [...TOKEN_DETAILS_COUNTERS, "is_estimated"].sort();
    expect(keys).toEqual(expected);
    expect(TOKEN_DETAILS_COUNTERS).toHaveLength(13);
  });

  it("all 13 numeric fields default to 0 and is_estimated defaults to false", () => {
    const td = zeroTokenDetails();
    for (const counter of TOKEN_DETAILS_COUNTERS) {
      expect(td[counter]).toBe(0);
    }
    expect(td.is_estimated).toBe(false);
  });

  it("rejects unknown/extra keys (extra=forbid parity)", () => {
    const result = TokenDetailsSchema.safeParse({ input_tokens: 1, bogus: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects negative counts", () => {
    expect(TokenDetailsSchema.safeParse({ input_tokens: -1 }).success).toBe(false);
  });

  it("rejects counts above the 100_000_000 bound (D1)", () => {
    expect(TOKEN_DETAILS_MAX).toBe(100_000_000);
    expect(TokenDetailsSchema.safeParse({ input_tokens: TOKEN_DETAILS_MAX }).success).toBe(true);
    expect(TokenDetailsSchema.safeParse({ input_tokens: TOKEN_DETAILS_MAX + 1 }).success).toBe(
      false,
    );
  });

  it("createTokenDetails fills omitted counters with 0", () => {
    const td = createTokenDetails({ input_tokens: 10, output_tokens: 5 });
    expect(td.input_tokens).toBe(10);
    expect(td.output_tokens).toBe(5);
    expect(td.cached_input_tokens).toBe(0);
    expect(td.is_estimated).toBe(false);
  });
});

describe("totalTokens (derived, non-serialized)", () => {
  it("is input_tokens + output_tokens", () => {
    const td = createTokenDetails({ input_tokens: 30, output_tokens: 12 });
    expect(totalTokens(td)).toBe(42);
  });

  it("never appears in the serialized wire object", () => {
    const wire = serializeTokenDetails(createTokenDetails({ input_tokens: 1, output_tokens: 2 }));
    expect(wire).not.toHaveProperty("total_tokens");
    expect(wire).not.toHaveProperty("totalTokens");
  });
});

describe("serializeTokenDetails — is_estimated omit-when-false quirk", () => {
  it("omits is_estimated entirely when false (default)", () => {
    const wire = serializeTokenDetails(zeroTokenDetails());
    expect(wire).not.toHaveProperty("is_estimated");
    // all 13 counters ARE present
    for (const counter of TOKEN_DETAILS_COUNTERS) {
      expect(wire).toHaveProperty(counter, 0);
    }
  });

  it("includes is_estimated as true when true", () => {
    const wire = serializeTokenDetails(createTokenDetails({ input_tokens: 5, is_estimated: true }));
    expect(wire["is_estimated"]).toBe(true);
    expect(wire["input_tokens"]).toBe(5);
  });

  it("never emits is_estimated: false", () => {
    const wire = serializeTokenDetails(createTokenDetails({ is_estimated: false }));
    expect(JSON.stringify(wire)).not.toContain("is_estimated");
  });

  it("serializes image token buckets even when both are zero", () => {
    const wire = serializeTokenDetails(zeroTokenDetails());
    expect(wire).toHaveProperty("image_input_tokens", 0);
    expect(wire).toHaveProperty("image_output_tokens", 0);
  });
});
