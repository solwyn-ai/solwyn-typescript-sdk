import { ConfigurationError } from "../errors";
import type { CurrentRun } from "../run-context";

export const MAGIC_MODELS = [
  "solwyn-test/deny",
  "solwyn-test/deny-alert",
  "solwyn-test/deny-tag",
  "solwyn-test/deny-stopped",
  "solwyn-test/runaway",
  "solwyn-test/kill",
  "solwyn-test/lease-ineligible",
] as const;

const MAGIC_MODEL_SET = new Set<string>(MAGIC_MODELS);
const RUN_SCOPED_MAGIC_MODEL_SET = new Set<string>([
  "solwyn-test/deny-stopped",
  "solwyn-test/runaway",
  "solwyn-test/kill",
]);

function testingError(message: string): ConfigurationError {
  return new ConfigurationError(`solwyn.testing: ${message}`, { field: "model" });
}

/** Validate every configured model before the normal client pipeline begins. */
export function validateTestingModels(
  models: readonly unknown[],
  run: CurrentRun | undefined,
): void {
  for (const value of models) {
    if (typeof value !== "string") continue;
    if (value.startsWith("solwyn-test/") && !MAGIC_MODEL_SET.has(value)) {
      throw testingError(`unknown magic model '${value}'`);
    }
  }
  for (const value of models) {
    if (typeof value === "string" && RUN_SCOPED_MAGIC_MODEL_SET.has(value) && run === undefined) {
      throw testingError(`run-scoped magic model '${value}' requires an open run`);
    }
  }
}
