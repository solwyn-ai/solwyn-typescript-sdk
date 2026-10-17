import { expect, it, vi } from "vitest";
import { noopLogger } from "../../src/logging";
import { MetadataReporter } from "../../src/reporter";
import {
  allowIngestContractDrift,
  assertNoIngestContractDrift,
  installIngestContractGuard,
} from "../helpers/ingest-contract";

const reporter = () =>
  new MetadataReporter("https://api.solwyn.test", `sk_proj_${"0".repeat(64)}`, {
    logger: noopLogger,
  });

it("accepts a current ingest response without contract drift", () => {
  expect(
    reporter()._parseIngestRejections({ ingested: 1, rejected: [], duplicates: [] }, 1),
  ).toMatchObject({ kind: "clean" });
  expect(assertNoIngestContractDrift).not.toThrow();
});

it.each([
  { ingested: 1, rejected: [] },
  {
    ingested: 0,
    rejected: [{ index: 1, code: "unknown_model", model: "synthetic", message: "Unknown model" }],
    duplicates: [],
  },
])("detects ingest drift with a silent logger after mocks are restored: %j", (body) => {
  allowIngestContractDrift();
  vi.restoreAllMocks();
  reporter()._parseIngestRejections(body, 1);
  expect(assertNoIngestContractDrift).toThrow("Unexpected ingest contract drift");
});

it("detects ingest drift after the reporter module is reloaded", async () => {
  allowIngestContractDrift();
  vi.resetModules();
  const { MetadataReporter: ReloadedReporter } = await import("../../src/reporter");
  expect(ReloadedReporter).not.toBe(MetadataReporter);
  installIngestContractGuard(ReloadedReporter);
  const reloaded = new ReloadedReporter("https://api.solwyn.test", `sk_proj_${"0".repeat(64)}`, {
    logger: noopLogger,
  });
  reloaded._parseIngestRejections({ ingested: 1, rejected: [] }, 1);
  expect(assertNoIngestContractDrift).toThrow("Unexpected ingest contract drift");
});
