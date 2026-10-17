import { afterEach, beforeEach, expect } from "vitest";
import { MetadataReporter } from "../../src/reporter";

let expectedDrift = false;
let driftCount = 0;
const guardedReporters = new WeakSet<typeof MetadataReporter>();

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

/** Install again on the fresh class after vi.resetModules(), preserving module isolation. */
export function installIngestContractGuard(reporter: typeof MetadataReporter): void {
  if (guardedReporters.has(reporter)) return;
  // Observe the reporter boundary rather than a logger, whose errors may be swallowed.
  // A plain wrapper survives tests restoring their own mocks and preserves diagnostics.
  const recordUnparseableResponse = reporter.prototype._recordUnparseableResponse;
  reporter.prototype._recordUnparseableResponse = function (error: unknown): void {
    driftCount += 1;
    recordUnparseableResponse.call(this, error);
  };
  guardedReporters.add(reporter);
}

installIngestContractGuard(MetadataReporter);

beforeEach(() => {
  expectedDrift = false;
  driftCount = 0;
});

afterEach(() => {
  if (!expectedDrift) assertNoIngestContractDrift();
});
