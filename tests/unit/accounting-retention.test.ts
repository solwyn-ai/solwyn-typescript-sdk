import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { currentRun, currentRunContext, run } from "../../src/node";
import { getCurrentRun } from "../../src/run-context";

it("keeps ownership tokens out of public attribution snapshots and enumerable metadata", () => {
  run("private-lifetime", () => {
    const internal = getCurrentRun();
    expect(internal?.lifetime).toBeDefined();
    expect(Object.keys(internal ?? {})).not.toContain("lifetime");
    expect(JSON.parse(JSON.stringify(internal))).not.toHaveProperty("lifetime");
    expect(Object.keys(currentRun() ?? {})).toEqual(["agentRunId", "agentRunName"]);
    expect(Object.keys(currentRunContext())).toEqual([
      "agentRunId",
      "agentRunName",
      "tags",
      "parentAgentRunId",
    ]);
  });
});

it("reclaims unreachable public run histories while preserving live accounting owners", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/accounting-retention.mts"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).ok).toBe(true);
}, 35_000);
