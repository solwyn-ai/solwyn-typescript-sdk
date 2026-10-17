import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("finalizes abandoned streams, collects unclosed clients, and releases run and probe ownership", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/abandoned-stream-retention.mts"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    abandoned: 10,
    unclosed_abandoned: 10,
    probe_released: true,
  });
}, 35_000);
