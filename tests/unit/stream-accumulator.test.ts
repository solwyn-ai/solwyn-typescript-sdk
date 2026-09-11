/**
 * Exercises the protocol-level `StreamUsageAccumulator` contract.
 *
 * The concrete per-provider extraction logic (OpenAI's terminal-chunk usage) is
 * exercised in `providers-openai.test.ts`; here we pin the shared contract every
 * accumulator must honor, plus that `OpenAIStreamAccumulator` conforms to it.
 */

import { describe, expect, it } from "vitest";
import { extractOpenAIUsage, OpenAIStreamAccumulator } from "../../src/providers/accumulator";
import type { StreamUsageAccumulator } from "../../src/providers/protocol";
import {
  buildTokenDetails,
  TOKEN_DETAILS_MAX,
  type TokenDetails,
  zeroTokenDetails,
} from "../../src/token-details";

/** A minimal structural fake — presence of the three methods is the whole contract. */
function structuralFake(): StreamUsageAccumulator {
  let usage: TokenDetails | null = null;
  let tier: string | null = null;
  return {
    observe(chunk: unknown): void {
      if (typeof chunk === "object" && chunk !== null && "usage" in chunk) {
        usage = zeroTokenDetails();
        tier = "default";
      }
    },
    finalize(): TokenDetails {
      return usage ?? buildTokenDetails({ is_estimated: true });
    },
    getServiceTier(): string | null {
      return tier;
    },
  };
}

describe("StreamUsageAccumulator contract — structural fake", () => {
  it("any object exposing observe/finalize/getServiceTier satisfies the interface", () => {
    const acc: StreamUsageAccumulator = structuralFake();
    expect(typeof acc.observe).toBe("function");
    expect(typeof acc.finalize).toBe("function");
    expect(typeof acc.getServiceTier).toBe("function");
  });

  it("finalize returns estimated zero counts and never throws when nothing was observed", () => {
    const acc = structuralFake();
    expect(() => acc.finalize()).not.toThrow();
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("finalize returns estimated zero for structural chunks with no usage", () => {
    const acc = structuralFake();
    acc.observe({});
    acc.observe({ type: "ping" });
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("keeps an observed explicit zero measurement unestimated", () => {
    const acc = structuralFake();
    acc.observe({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(acc.finalize()).toEqual(zeroTokenDetails());
  });
});

describe("StreamUsageAccumulator contract — OpenAIStreamAccumulator conforms", () => {
  it("is assignable to the interface and marks empty-stream usage estimated", () => {
    const acc: StreamUsageAccumulator = new OpenAIStreamAccumulator();
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("keeps complete explicit zero usage measured", () => {
    const acc: StreamUsageAccumulator = new OpenAIStreamAccumulator();
    acc.observe({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(acc.finalize()).toEqual(zeroTokenDetails());
  });

  it("finalize never throws even on a garbage chunk shape", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe(null);
    acc.observe(42);
    acc.observe({ usage: "not-an-object" });
    expect(() => acc.finalize()).not.toThrow();
    expect(() => acc.getServiceTier()).not.toThrow();
  });

  it("settles usage from a terminal usage-bearing chunk (usage settles from terminal chunks)", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe({ choices: [{ index: 0 }] });
    acc.observe({ usage: { prompt_tokens: 8, completion_tokens: 4 } });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(8);
    expect(details.output_tokens).toBe(4);
  });

  it("does NOT throw when a usage count exceeds the wire cap; the count flows through (F10)", () => {
    // The extractors build a PLAIN TokenDetails (no zod parse), so an out-of-bound
    // count degrades at the reporter's wire boundary, never as a ZodError out of
    // extraction; extractUsage must never throw.
    const overCap = TOKEN_DETAILS_MAX + 1;
    expect(() =>
      extractOpenAIUsage({ usage: { prompt_tokens: overCap, completion_tokens: 1 } }),
    ).not.toThrow();
    const details = extractOpenAIUsage({ usage: { prompt_tokens: overCap, completion_tokens: 1 } });
    expect(details.input_tokens).toBe(overCap);

    const acc = new OpenAIStreamAccumulator();
    acc.observe({ usage: { prompt_tokens: overCap, completion_tokens: 1 } });
    expect(() => acc.finalize()).not.toThrow();
    expect(acc.finalize().input_tokens).toBe(overCap);
  });
});
