import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  ["success", "0", "pass", "removed"],
  ["failure", "0", "fail", "removed"],
  ["success", "1", "pass", "retained"],
  ["failure", "1", "fail", "retained"],
  ["cleanup-error", "0", "fail", "cleanup-failed"],
  ["cleanup-error-after-failure", "0", "fail", "cleanup-failed"],
])("persists %s with SMOKE_KEEP=%s and %s/%s lifecycle", (scenario, keep, status, state) => {
  const out = mkdtempSync(path.join(tmpdir(), "task3-runtime-consumer-lifecycle-"));
  temporary.push(out);
  const parentContainer = mkdtempSync(path.join(out, "parent-owned-"));
  const tarball = path.join(out, "artifact.tgz");
  const driver = path.join(out, "driver.mjs");
  const hooks = path.join(out, "faults.mjs");
  const helper = new URL("../../scripts/verification/runtime-support.mjs", import.meta.url).href;
  const support = new URL("../../scripts/verification/support.mjs", import.meta.url).href;
  writeFileSync(tarball, "lifecycle proof without package installation");
  writeFileSync(
    driver,
    `
    import {writeFileSync} from 'node:fs';
    import path from 'node:path';
    import {runProbe} from ${JSON.stringify(helper)};
    import {createTemporaryRoot} from ${JSON.stringify(support)};
    await runProbe('consumer-lifecycle',async(_options,report,evidence)=>{
      report.details.createdRoots=[];
      for(const label of ['lifecycle-a','lifecycle-b']){
        const directory=createTemporaryRoot('solwyn-consumer-'+label+'-',report);
        report.details.createdRoots.push(directory);
        writeFileSync(path.join(directory,'marker'),'owned by this probe');
      }
      if(process.env.CONSUMER_SCENARIO.includes('failure'))throw new Error('synthetic proof failure');
    });
  `,
  );
  writeFileSync(
    hooks,
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const remove=fs.rmSync;
    fs.rmSync=(directory,...args)=>{
      if(process.env.CONSUMER_SCENARIO.startsWith('cleanup-error') && /^solwyn-consumer-lifecycle-[ab]-/.test(path.basename(directory)))throw Object.assign(new Error('synthetic cleanup permission error'),{code:'EACCES'});
      return remove(directory,...args);
    };
  `,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", hooks, driver, "--tarball", tarball, "--out", out],
    {
      env: {
        ...process.env,
        CONSUMER_SCENARIO: scenario,
        SMOKE_KEEP: keep,
        SOLWYN_VERIFICATION_TEMP_ROOT: parentContainer,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  const report = JSON.parse(readFileSync(path.join(out, "consumer-lifecycle.json"), "utf8"));
  temporary.push(...report.details.createdRoots);
  expect(result.status).toBe(status === "pass" ? 0 : 1);
  expect(report.status).toBe(status);
  expect(report.schemaVersion).toBe(1);
  expect(report.cleanup.keepRequested).toBe(keep === "1");
  expect(report.cleanup.roots).toHaveLength(2);
  for (const root of report.cleanup.roots) {
    expect(path.dirname(root.path)).toBe(realpathSync(parentContainer));
    expect(root.state).toBe(state);
    expect(root.retained).toBe(state !== "removed");
    expect(existsSync(root.path)).toBe(state !== "removed");
  }
  if (scenario === "cleanup-error") expect(report.cleanup.failure.phase).toBe("cleanup");
  if (scenario === "cleanup-error-after-failure")
    expect(report.details.error).toContain("synthetic proof failure");
  expect(existsSync(tarball)).toBe(true);
});
