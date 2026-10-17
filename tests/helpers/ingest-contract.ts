import { afterEach, beforeEach, expect } from "vitest";
import { MetadataReporter } from "../../src/reporter";

let expectedDrift = false;
let driftCount = 0;

/** Opt in only when the test deliberately exercises malformed ingest responses. */
export function allowIngestContractDrift(): void {
  expectedDrift = true;
}

export function assertNoIngestContractDrift(): void {
  expect(
    driftCount,
    "Unexpected ingest contract drift; fix the fixture or explicitly allow intentional drift",
  ).toBe(0);
}

// Observe the reporter boundary rather than a logger, whose errors may be swallowed.
// A plain wrapper survives tests restoring their own mocks and preserves diagnostics.
const recordUnparseableResponse = MetadataReporter.prototype._recordUnparseableResponse;
MetadataReporter.prototype._recordUnparseableResponse = function (error: unknown): void {
  driftCount += 1;
  recordUnparseableResponse.call(this, error);
};

beforeEach(() => {
  expectedDrift = false;
  driftCount = 0;
});

afterEach(() => {
  if (!expectedDrift) assertNoIngestContractDrift();
});
