/**
 * Protocol conformance is a compile-time TypeScript guarantee based on structural typing.
 * This file exercises that through `tsc` assignability: a complete stub typechecks as a
 * `ProviderAdapter`; an incomplete stub is rejected (`@ts-expect-error`).
 */

import { describe, expect, it } from "vitest";
import type {
  Dialect,
  PreparedDispatch,
  ProviderAdapter,
  StreamUsageAccumulator,
} from "../../src/providers/protocol";
import { zeroTokenDetails } from "../../src/token-details";

function makeAccumulator(): StreamUsageAccumulator {
  let seen = false;
  return {
    observe(): void {
      seen = true;
    },
    finalize() {
      return zeroTokenDetails();
    },
    getServiceTier() {
      return seen ? "default" : null;
    },
  };
}

// A complete, conforming adapter must typecheck as ProviderAdapter.
const conformingAdapter: ProviderAdapter = {
  name: "openai",
  dialect: "openai" satisfies Dialect,
  detectClient() {
    return false;
  },
  detectModel(model: string) {
    return model.startsWith("gpt-");
  },
  extractUsage() {
    return zeroTokenDetails();
  },
  estimateMissingUsage() {
    return null;
  },
  extractServiceTier() {
    return null;
  },
  extractRegion() {
    return null;
  },
  prepareStreaming(kwargs) {
    return { ...kwargs };
  },
  createStreamAccumulator() {
    return makeAccumulator();
  },
  prepareCall(): PreparedDispatch {
    return () => undefined;
  },
  unwrapStreamSource(response) {
    return response;
  },
  wrapStreamResult(wrapper) {
    return wrapper;
  },
};

// An adapter missing `extractRegion` must NOT satisfy the interface.
// @ts-expect-error — extractRegion is mandatory; omitting it fails conformance.
const incompleteAdapter: ProviderAdapter = {
  name: "broken",
  dialect: "openai",
  detectClient: () => false,
  detectModel: () => false,
  extractUsage: () => zeroTokenDetails(),
  estimateMissingUsage: () => null,
  extractServiceTier: () => null,
  prepareStreaming: (k) => ({ ...k }),
  createStreamAccumulator: () => makeAccumulator(),
  prepareCall: (): PreparedDispatch => () => undefined,
  unwrapStreamSource: (r) => r,
  wrapStreamResult: (w) => w,
};

describe("ProviderAdapter interface", () => {
  it("a conforming adapter exposes the full protocol surface", () => {
    expect(conformingAdapter.name).toBe("openai");
    expect(conformingAdapter.dialect).toBe("openai");
    expect(conformingAdapter.detectModel("gpt-4o")).toBe(true);
    expect(conformingAdapter.estimateMissingUsage({}, { estimatedInputTokens: 1 })).toBeNull();
    expect(conformingAdapter.extractRegion({})).toBeNull();
  });

  it("a fresh accumulator finalizes to all-zero and getServiceTier is null", () => {
    const acc = conformingAdapter.createStreamAccumulator();
    expect(acc.finalize().input_tokens).toBe(0);
    expect(acc.getServiceTier()).toBeNull();
  });

  it("references the incomplete stub so @ts-expect-error is exercised", () => {
    expect(incompleteAdapter).toBeTypeOf("object");
  });
});
