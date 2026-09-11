import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("separates process-cached clone resources from live user MessageChannels", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/accounting-node-clone-retention.mts"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, user_message_channel: true });
}, 35_000);
