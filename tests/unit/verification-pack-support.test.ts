import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const support = new URL("../../scripts/verification/support.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  "outside",
  "inside",
  "symlink-inside",
])("uses canonical outside-repository argument validation: %s", (mode) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-support-boundary-"));
  temporary.push(scratch);
  const scripts = path.join(scratch, "repo/scripts/verification");
  mkdirSync(scripts, { recursive: true });
  for (const file of ["process.mjs", "support.mjs"])
    copyFileSync(path.join(repository, "scripts/verification", file), path.join(scripts, file));
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const linked = path.join(scratch, "linked-repo");
  symlinkSync(path.join(scratch, "repo"), linked, "junction");
  const out =
    mode === "outside"
      ? path.join(scratch, "output")
      : mode === "inside"
        ? path.join(scratch, "repo/output")
        : path.join(linked, "output");
  const program = `import {parseArguments} from ${JSON.stringify(pathToFileURL(path.join(scripts, "support.mjs")).href)};let accepted=true;try{parseArguments(['--tarball',${JSON.stringify(artifact)},'--out',${JSON.stringify(out)}]);}catch{accepted=false;}process.stdout.write(JSON.stringify({accepted}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).accepted).toBe(mode === "outside");
});

it.each([
  false,
  true,
])("finalizes only registered roots, preserving primary and cleanup outcomes: keep=%s", (keep) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-support-cleanup-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const file = path.join(scratch, "report.json");
  const program = `import fs from 'node:fs';import {createReport,createTemporaryRoot,finalizeReport} from ${JSON.stringify(support)};const report=createReport({probe:'test-probe',tarball:${JSON.stringify(artifact)},env:{SMOKE_KEEP:${JSON.stringify(keep ? "1" : "0")}}});const root=createTemporaryRoot('solwyn-support-',report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)}}});report.details.untrustedRoot=${JSON.stringify(scratch)};report.status='pass';finalizeReport(report,${JSON.stringify(file)});process.stdout.write(JSON.stringify({report,exists:fs.existsSync(root),untrustedExists:fs.existsSync(${JSON.stringify(scratch)})}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.report.status).toBe("pass");
  expect(data.report.cleanup.failure).toBeNull();
  expect(data.exists).toBe(keep);
  expect(data.untrustedExists).toBe(true);
  expect(data.report.cleanup.roots[0]).toMatchObject({
    state: keep ? "retained" : "removed",
    retained: keep,
  });
});

it("persists cleanup failure separately from the original classifiable failure", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-support-failure-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const file = path.join(scratch, "report.json");
  const program = `import fs from 'node:fs';import {createReport,createTemporaryRoot,finalizeReport} from ${JSON.stringify(support)};const report=createReport({probe:'test-probe',tarball:${JSON.stringify(artifact)}});createTemporaryRoot('solwyn-support-',report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)}}});report.failure={phase:'dependency-setup',kind:'network',retryable:true,artifactFailure:false,errorCode:'ENOTFOUND'};fs.rmSync=()=>{throw Object.assign(new Error('injected cleanup failure'),{code:'EACCES'});};finalizeReport(report,${JSON.stringify(file)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(readFileSync(file, "utf8"));
  expect(report.status).toBe("fail");
  expect(report.failure.errorCode).toBe("ENOTFOUND");
  expect(report.cleanup.failure).toMatchObject({
    phase: "cleanup",
    errorCode: "EACCES",
    artifactFailure: false,
  });
  expect(report.cleanup.roots[0]).toMatchObject({ state: "cleanup-failed", retained: true });
});

it.each([
  "unregistered",
  "replaced-root",
])("never deletes a root without current private ownership: %s", (mode) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-support-ownership-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const program = `import fs from 'node:fs';import {createReport,createTemporaryRoot,cleanupTemporaryRoot} from ${JSON.stringify(support)};const report=createReport({probe:'test-probe',tarball:${JSON.stringify(artifact)}});let target=${JSON.stringify(scratch)};if(${mode === "replaced-root"}){target=createTemporaryRoot('solwyn-owned-',report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)}}});fs.rmSync(target,{recursive:true,force:true});fs.symlinkSync(${JSON.stringify(scratch)},target,'junction');}let record;let rejected=false;try{record=cleanupTemporaryRoot(target);}catch{rejected=true;}process.stdout.write(JSON.stringify({record,rejected,artifactExists:fs.existsSync(${JSON.stringify(artifact)})}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.artifactExists).toBe(true);
  if (mode === "unregistered") expect(result.rejected).toBe(true);
  else expect(result.record).toMatchObject({ state: "cleanup-failed", retained: true });
});
