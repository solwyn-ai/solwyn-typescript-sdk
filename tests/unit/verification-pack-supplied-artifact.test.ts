import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("tests supplied pack bytes without launching build or npm pack", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-supplied-pack-"));
  temporary.push(scratch);
  const scripts = path.join(scratch, "repo/scripts");
  mkdirSync(path.join(scripts, "verification"), { recursive: true });
  copyFileSync(
    path.join(repository, "scripts/pack-smoke.mjs"),
    path.join(scripts, "pack-smoke.mjs"),
  );
  for (const file of ["support.mjs", "process.mjs"])
    copyFileSync(
      path.join(repository, "scripts/verification", file),
      path.join(scripts, "verification", file),
    );
  const artifact = path.join(scratch, "reviewed.tgz");
  writeFileSync(artifact, "abc");
  const out = path.join(scratch, "output");
  const calls = path.join(scratch, "calls.json");
  writeFileSync(
    path.join(scripts, "verification/package-consumers.mjs"),
    `import fs from 'node:fs';export async function runPackageConsumers(options){fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(options));if(fs.readFileSync(options.tarball,'utf8')!=='abc')throw new Error('artifact changed');return {status:'pass',artifact:{path:options.tarball,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}};}`,
  );
  const preload = path.join(scratch, "forbid-process.mjs");
  writeFileSync(
    preload,
    "import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawn=()=>{throw new Error('Unexpected build or pack subprocess');};syncBuiltinESMExports();",
  );
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      path.join(scripts, "pack-smoke.mjs"),
      "--",
      "--tarball",
      artifact,
      "--out",
      out,
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(readFileSync(calls, "utf8"))).toMatchObject({
    tarball: expect.stringContaining("reviewed.tgz"),
    out: expect.stringContaining("output"),
  });
  expect(readFileSync(artifact, "utf8")).toBe("abc");
  expect(child.stdout).toContain("PASS ba7816bf");
});
