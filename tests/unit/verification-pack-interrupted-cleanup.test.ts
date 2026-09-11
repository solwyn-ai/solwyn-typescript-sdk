import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  "remove",
  "keep",
  "forged-report",
  "missing-report",
  "cleanup-error",
  "cleanup-primary-error",
])("cleans owned containers after forced probe timeouts: %s", (scenario) => {
  const keep = scenario === "keep";
  const cleanupError = scenario.startsWith("cleanup-");
  const primaryFailure =
    scenario === "cleanup-primary-error"
      ? {
          phase: "dependency-setup",
          kind: "network",
          retryable: true,
          artifactFailure: false,
          errorCode: "ENOTFOUND",
        }
      : undefined;
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-interrupted-"));
  temporary.push(scratch);
  const scripts = path.join(scratch, "repo/scripts/verification");
  const out = path.join(scratch, "out");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(out);
  const tarball = path.join(scratch, "artifact.tgz");
  writeFileSync(tarball, "same reviewed bytes");
  const preload = path.join(scratch, "cleanup-error.cjs");
  writeFileSync(
    preload,
    "const fs=require('node:fs');const original=fs.rmSync;fs.rmSync=(target,options)=>{if(require('node:path').basename(target).startsWith('solwyn-verification-')){if(options.maxRetries!==3||options.retryDelay!==100)throw Object.assign(new Error('missing bounded cleanup retries'),{code:'ERETRY'});throw Object.assign(new Error('injected aggregate cleanup failure'),{code:'EACCES'});}return original(target,options);};",
  );
  for (const file of ["artifact-identity.mjs", "process.mjs", "support.mjs"])
    copyFileSync(path.join(repository, "scripts/verification", file), path.join(scripts, file));
  writeFileSync(
    path.join(scripts, "run.mjs"),
    readFileSync(path.join(repository, "scripts/verification/run.mjs"), "utf8").replace(
      "timeout: 900_000",
      "timeout: 300",
    ),
  );
  const shapes = {
    "package-consumers": "solwyn-consumer-",
    "native-type-consumer": "solwyn-native-types-",
    "ai-type-consumer": "solwyn-ai-types-",
    "bundle-proofs": "solwyn-consumer-bundle-",
    "browser-proof": "solwyn-consumer-browser-",
    "runtime-matrix": "solwyn-consumer-matrix-native-",
    "google-native-compat": "solwyn-consumer-google-floor-",
  };
  for (const [probe, prefix] of Object.entries(shapes)) {
    writeFileSync(
      path.join(scripts, `${probe}.mjs`),
      `import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';const artifact=process.argv[process.argv.indexOf('--tarball')+1];const actualRoot=fs.mkdtempSync(path.join(process.env.SOLWYN_VERIFICATION_TEMP_ROOT,${JSON.stringify(prefix)}));const root=${scenario === "forged-report" ? JSON.stringify(scratch) : "actualRoot"};const details=${probe === "browser-proof" ? "{profile:root}" : probe.includes("type-consumer") || probe === "package-consumers" ? "{consumerRoot:root}" : "{consumerCleanup:{roots:[{path:root,state:'created'}]}}"};details.actualRoot=actualRoot;${scenario === "missing-report" ? "" : `fs.writeFileSync(${JSON.stringify(path.join(out, `${probe}.json`))},JSON.stringify({schemaVersion:1,probe:${JSON.stringify(probe)},status:'fail',artifact:{path:artifact,sha256:createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')},versions:{node:process.version},checks:{},details,failure:${JSON.stringify(primaryFailure ?? null)},cleanup:{keepRequested:${keep},roots:[{path:root,state:'created',retained:true}],failure:null}}));`}setInterval(()=>{},1000);`,
    );
  }
  const child = spawnSync(
    process.execPath,
    [path.join(scripts, "run.mjs"), "--tarball", tarball, "--out", out],
    {
      env: {
        ...process.env,
        SMOKE_KEEP: keep ? "1" : "0",
        ...(cleanupError ? { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } : {}),
      },
      encoding: "utf8",
      timeout: 6000,
      killSignal: "SIGKILL",
    },
  );
  const evidence = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8"));
  for (const entry of evidence.details.probes) {
    temporary.push(
      entry.consumerCleanup?.path ??
        entry.result.details.consumerRoot ??
        entry.result.details.profile ??
        entry.result.details.consumerCleanup.roots[0].path,
    );
  }
  expect(child.status, child.stderr).toBe(1);
  expect(evidence.details.probes).toHaveLength(7);
  for (const entry of evidence.details.probes) {
    const root = entry.result?.details.actualRoot;
    expect(entry.command.timedOut).toBe(true);
    expect(entry.status).toBe("fail");
    if (root) expect(existsSync(root)).toBe(keep || cleanupError);
    expect(entry.consumerCleanup).toMatchObject({
      state: cleanupError ? "cleanup-failed" : keep ? "retained" : "removed",
      retained: keep || cleanupError,
    });
    if (cleanupError) {
      expect(entry.consumerCleanup.failure.errorCode).toBe("EACCES");
      expect(entry.failure).toEqual(
        primaryFailure ?? {
          phase: "probe",
          kind: "timeout",
          retryable: true,
          artifactFailure: false,
          errorCode: "ETIMEDOUT",
        },
      );
      expect(entry.consumerCleanup.failure).toEqual({
        phase: "cleanup",
        kind: "runner-error",
        retryable: false,
        artifactFailure: false,
        errorCode: "EACCES",
      });
    }
    if (root) expect(path.dirname(root)).toBe(entry.consumerCleanup.path);
    expect(existsSync(scratch)).toBe(true);
  }
});
