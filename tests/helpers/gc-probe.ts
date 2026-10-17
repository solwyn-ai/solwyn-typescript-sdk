import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const gcProbeTimeout = 125_000;

export async function runGcProbe(name: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", `tests/probes/${name}.mts`, ...args],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 120_000 },
  );
  return stdout;
}
