import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("tracks promises only while callback or detached run lifetimes are live", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/node-hook-lifetime.mts"],
    { cwd: process.cwd(), timeout: 30_000 },
  );
  expect(JSON.parse(stdout)).toEqual({ idle: true, concurrent: true, detached: true });
}, 35_000);
