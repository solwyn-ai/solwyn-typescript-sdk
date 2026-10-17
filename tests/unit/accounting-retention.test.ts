import { expect, it } from "vitest";
import { currentRun, currentRunContext, run } from "../../src/node";
import { getCurrentRun } from "../../src/run-context";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

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

it.concurrent.each([
  "retained-denial",
  "ai-histories",
  "completed-granted",
  "completed-ineligible",
  "retained-completed-promises",
  "retained-terminal-native-streams",
  "async-resource-owner",
  "granted-handle",
  "ineligible-handle",
  "active-stream",
  "background-frame",
  "refused-surrender",
  "identity-only-reuse",
  "unmanaged-before-owned",
  "pending-renewal",
  "revival-during-retirement",
  "idle-release-dispatcher",
])(
  "reclaims unreachable accounting owners: %s",
  async (scenario) => {
    const stdout = await runGcProbe("accounting-retention", scenario);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, scenario });
  },
  gcProbeTimeout,
);
