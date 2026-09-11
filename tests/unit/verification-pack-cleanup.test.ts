import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const support = new URL("../../scripts/verification/support.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  false,
  true,
])("persists cleanup failure without masking an earlier failure: %s", (priorFailure) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-cleanup-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const file = path.join(scratch, "report.json");
  const program = `import fs from 'node:fs';import {createReport,createTemporaryRoot,finalizeReport} from ${JSON.stringify(support)};
const report=createReport({probe:'package-consumers',tarball:${JSON.stringify(artifact)}});createTemporaryRoot('solwyn-cleanup-',report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)}}});report.status=${JSON.stringify(priorFailure ? "fail" : "pass")};${priorFailure ? "report.failure={phase:'verification',kind:'original',retryable:false,artifactFailure:true,errorCode:'ERR_ASSERTION'};report.details.error='original failure';" : ""}fs.rmSync=()=>{throw Object.assign(new Error('injected cleanup failure'),{code:'EACCES'});};finalizeReport(report,${JSON.stringify(file)});process.stdout.write(JSON.stringify(report));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  const report = JSON.parse(child.stdout);
  expect(report.status).toBe("fail");
  expect(report.cleanup.failure).toMatchObject({
    phase: "cleanup",
    errorCode: "EACCES",
    artifactFailure: false,
  });
  expect(report.cleanup.roots[0]).toMatchObject({
    state: "cleanup-failed",
    retained: true,
    error: "injected cleanup failure",
  });
  if (priorFailure) {
    expect(report.failure.kind).toBe("original");
    expect(report.details.error).toBe("original failure");
  } else expect(report.failure).toBeNull();
});

it.each([false, true])("records observed cleanup retention with SMOKE_KEEP: %s", (keep) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-cleanup-keep-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const program = `import {createReport,createTemporaryRoot,finalizeReport} from ${JSON.stringify(support)};const report=createReport({probe:'package-consumers',tarball:${JSON.stringify(artifact)},env:{SMOKE_KEEP:${JSON.stringify(keep ? "1" : "0")}}});createTemporaryRoot('solwyn-cleanup-',report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)}}});report.status='pass';finalizeReport(report,${JSON.stringify(path.join(scratch, "report.json"))});process.stdout.write(JSON.stringify(report));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  const report = JSON.parse(child.stdout);
  expect(report.status).toBe("pass");
  expect(report.cleanup.failure).toBeNull();
  expect(report.cleanup.roots[0]).toMatchObject({
    state: keep ? "retained" : "removed",
    retained: keep,
  });
});
