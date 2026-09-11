import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const preload = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const code=process.env.SETUP_FAULT;
const observe=()=>{
  const report=fs.existsSync(process.env.SETUP_REPORT)?JSON.parse(fs.readFileSync(process.env.SETUP_REPORT,'utf8')):null;
  fs.writeFileSync(process.env.SETUP_OBSERVATION,JSON.stringify(report?.details?.commands?.at(-1)??null));
};
const originalTimeout=setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,code==='timeout'&&ms>=1000?500:ms,...args);
const spawn=childProcess.spawn;
childProcess.spawn=(...args)=>{
  observe();
  return spawn(...args);
};
syncBuiltinESMExports();
`;

it.each([
  ["bundle-proofs", "ENOTFOUND", "network", true],
  ["runtime-matrix", "ECONNRESET", "network", true],
  ["google-native-compat", "EAI_AGAIN", "network", true],
  ["bundle-proofs", "ETIMEDOUT", "network", true],
  ["bundle-proofs", "ENETUNREACH", "network", true],
  ["bundle-proofs", "ECONNREFUSED", "network", true],
  ["bundle-proofs", "ERR_SOCKET_TIMEOUT", "network", true],
  ["bundle-proofs", "timeout", "timeout", true],
  ["runtime-matrix", "EACCES", "command-failure", false],
])("%s records %s as a setup failure", (probe, code, kind, retryable) => {
  const out = mkdtempSync(path.join(tmpdir(), "task3-runtime-setup-"));
  temporary.push(out);
  const tarball = path.join(out, "artifact.tgz");
  const hooks = path.join(out, "faults.mjs");
  const reportPath = path.join(out, `${probe}.json`);
  const observation = path.join(out, "before-launch.json");
  const cli = path.join(out, "npm-cli.js");
  const cliSource =
    "if(process.env.SETUP_FAULT==='timeout'){setInterval(()=>{},1000);}else{process.stderr.write('npm error code '+process.env.SETUP_FAULT);process.exitCode=1;}";
  writeFileSync(tarball, "setup fails before artifact installation");
  writeFileSync(hooks, preload);
  writeFileSync(cli, cliSource);
  writeFileSync(path.join(out, "npm"), `#!/usr/bin/env node\n${cliSource}\n`, { mode: 0o755 });
  const env = { ...process.env };
  const inheritedPath =
    Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env["PATH"] = [out, path.dirname(process.execPath), inheritedPath].join(path.delimiter);
  env["npm_execpath"] = cli;
  const script = fileURLToPath(new URL(`../../scripts/verification/${probe}.mjs`, import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", hooks, script, "--tarball", tarball, "--out", out],
    {
      env: {
        ...env,
        SETUP_FAULT: String(code),
        SETUP_REPORT: reportPath,
        SETUP_OBSERVATION: observation,
        SMOKE_KEEP: "0",
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const install = report.details.commands?.find(
    (record: { binary: string }) => record.binary === "npm",
  );
  const consumer = install?.cwd;
  if (typeof consumer === "string" && path.basename(consumer).startsWith("solwyn-consumer-"))
    temporary.push(consumer);
  expect(report.status).toBe("fail");
  expect(existsSync(consumer), "failed install left its consumer directory behind").toBe(false);
  expect(report.schemaVersion).toBe(1);
  expect(report.failure).toMatchObject({
    phase: "dependency-setup",
    kind,
    retryable,
    artifactFailure: false,
  });
  expect(install).toMatchObject({ binary: "npm", state: "finished" });
  expect(JSON.parse(readFileSync(observation, "utf8"))).toMatchObject({
    binary: "npm",
    state: "running",
  });
});
