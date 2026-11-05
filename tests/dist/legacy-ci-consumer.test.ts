/**
 * The legacy-runtime CI job runs two inline consumer programs against the packed artifact. They
 * are scripts inside `.github/workflows/ci.yml`, so nothing else type-checks or runs them before
 * CI does. This test extracts both heredocs verbatim and runs them against the built package
 * (resolved by self-reference from the repository root) in an environment with no
 * `SOLWYN_PROJECT`, exactly as the clean CI runner does.
 *
 * Requires a prior `pnpm build`; run via `pnpm test:dist`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflow = parse(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};

function heredoc(stepName: string): string {
  for (const job of Object.values(workflow.jobs)) {
    const step = job.steps?.find((candidate) => candidate.name === stepName);
    if (step?.run === undefined) continue;
    const match = /<<'NODE'\n([\s\S]*?)\nNODE\s*$/.exec(step.run);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`workflow step not found: ${stepName}`);
}

function runNode(inputType: "module" | "commonjs", source: string) {
  const env = { ...process.env };
  delete env["SOLWYN_PROJECT"];
  delete env["SOLWYN_API_KEY"];
  return spawnSync(process.execPath, [`--input-type=${inputType}`], {
    cwd: root,
    input: source,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

describe("legacy-runtime CI consumer programs", () => {
  it.each([
    ["Exercise the ESM core and testing entry", "module"],
    ["Exercise the CommonJS core and testing entry", "commonjs"],
  ] as const)("%s runs against the built package without SOLWYN_PROJECT", (stepName, inputType) => {
    const result = runNode(inputType, heredoc(stepName));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
