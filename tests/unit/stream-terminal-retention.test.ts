import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("releases terminal stream ownership while preserving active streams and cached Responses", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/stream-terminal-retention.mts"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, active_stream: true });
}, 35_000);
