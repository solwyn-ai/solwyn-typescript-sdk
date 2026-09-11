import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const support = new URL("../../scripts/verification/support.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

it.each([
  ["success", "", true],
  ["interrupted fail without classification", "report.status='fail'", true],
  ["classified failure", "report.status='fail';report.failure=failure", true],
  ["missing schema", "delete report.schemaVersion", false],
  ["unknown schema", "report.schemaVersion=2", false],
  ["wrong probe", "report.probe='other-probe'", false],
  ["relative artifact", "report.artifact.path='artifact.tgz'", false],
  ["invalid hash", "report.artifact.sha256='not-a-hash'", false],
  ["wrong artifact hash", "report.artifact.sha256='0'.repeat(64)", false],
  ["missing node version", "delete report.versions.node", false],
  ["missing details", "delete report.details", false],
  ["array details", "report.details=[]", false],
  ["missing checks", "delete report.checks", false],
  ["array checks", "report.checks=[]", false],
  ["missing primary failure", "delete report.failure", false],
  ["successful primary failure", "report.failure=failure", false],
  ["missing cleanup failure", "delete report.cleanup.failure", false],
  ["successful cleanup failure", "report.cleanup.failure=failure", false],
  [
    "incomplete cleanup",
    "report.cleanup.roots=[{path:artifact,state:'created',retained:true}]",
    false,
  ],
  [
    "removed but retained",
    "report.cleanup.roots=[{path:artifact,state:'removed',retained:true}]",
    false,
  ],
  [
    "retained without keep request",
    "report.cleanup.roots=[{path:artifact,state:'retained',retained:true}]",
    false,
  ],
  [
    "intentional retention",
    "report.cleanup.keepRequested=true;report.cleanup.roots=[{path:artifact,state:'retained',retained:true}]",
    true,
  ],
] as const)("validates canonical report: %s", (_name, mutation, accepted) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-schema-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const program = `import {assertReport} from ${JSON.stringify(support)};const artifact=${JSON.stringify(artifact)};const failure={phase:'verification',kind:'assertion',retryable:false,artifactFailure:true,errorCode:'ERR_ASSERTION'};const report={schemaVersion:1,probe:'package-consumers',status:'pass',artifact:{path:artifact,sha256:${JSON.stringify(hash)}},versions:{node:'v24.11.1'},details:{},checks:{},failure:null,cleanup:{keepRequested:false,roots:[],failure:null}};${mutation};let accepted=true;try{assertReport(report,{probe:'package-consumers',artifact:{path:artifact,sha256:${JSON.stringify(hash)}}});}catch{accepted=false;}process.stdout.write(JSON.stringify({accepted}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout).accepted).toBe(accepted);
});

it("creates and persists the canonical artifact/report shape", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-schema-create-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const program = `import fs from 'node:fs';import {createReport,writeReport} from ${JSON.stringify(support)};const report=createReport({probe:'package-consumers',tarball:${JSON.stringify(artifact)},versions:{typescript:'6.0.3'}});writeReport(${JSON.stringify(path.join(scratch, "package-consumers.json"))},report);process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(scratch, "package-consumers.json"))},'utf8'));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result).toMatchObject({
    schemaVersion: 1,
    probe: "package-consumers",
    status: "fail",
    artifact: { path: realpathSync(artifact), sha256: hash },
    details: {},
    checks: {},
    failure: null,
    cleanup: { keepRequested: false, roots: [], failure: null },
  });
  expect(result.versions).toEqual({ node: process.version, typescript: "6.0.3" });
});
