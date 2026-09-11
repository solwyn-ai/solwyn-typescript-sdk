import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const verifier = new URL("../../scripts/verification/process.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  "posix",
  "windows",
])("does not signal a known-exited root on %s while pipes remain open", (mode) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-pack-exit-"));
  temporary.push(scratch);
  const descendant = path.join(scratch, "descendant.cjs");
  const root = path.join(scratch, "root.cjs");
  const caller = path.join(scratch, "caller.mjs");
  const evidencePath = path.join(scratch, "evidence.json");
  writeFileSync(
    descendant,
    "process.stdout.write('descendant-pid:'+process.pid+'\\n');setTimeout(()=>process.exit(0),5000);",
  );
  writeFileSync(
    root,
    `require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'inherit',detached:true});process.stdout.write('root-exiting\\n');process.exit(0);`,
  );
  writeFileSync(
    caller,
    `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const originalSpawn=cp.spawn;const originalKill=process.kill;const actions=[];let observedRoot;let rootExited=false;
cp.spawn=(binary,args,options)=>{if(binary==='taskkill.exe'){actions.push({kind:'taskkill',afterExit:rootExited});return originalSpawn(process.execPath,['-e','process.exit(0)'],options);}const child=originalSpawn(binary,args,options);if(!observedRoot){observedRoot=child;child.on('exit',()=>{rootExited=true;});const kill=child.kill.bind(child);child.kill=signal=>{actions.push({kind:'root-kill',afterExit:rootExited});return kill(signal);};}return child;};
process.kill=(pid,signal)=>{if(observedRoot&&Math.abs(pid)===observedRoot.pid)actions.push({kind:'group-kill',afterExit:rootExited});return originalKill(pid,signal);};syncBuiltinESMExports();
${mode === "windows" ? "Object.defineProperty(process,'platform',{value:'win32'});" : ""}
const {runBoundedCommand}=await import(${JSON.stringify(verifier)});const start=Date.now();const result=await runBoundedCommand(process.execPath,[${JSON.stringify(root)}],{timeout:2000});fs.writeFileSync(${JSON.stringify(evidencePath)},JSON.stringify({elapsed:Date.now()-start,...result,error:result.error?.message,actions}));`,
  );
  const started = Date.now();
  const child = spawnSync(process.execPath, [caller], {
    encoding: "utf8",
    timeout: 4000,
    killSignal: "SIGKILL",
  });
  expect(child.status, child.stderr).toBe(0);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const descendantPid = Number(/descendant-pid:(\d+)/.exec(evidence.stdout)?.[1]);
  try {
    expect(descendantPid).toBeGreaterThan(0);
    expect(evidence.actions.filter((action: { afterExit: boolean }) => action.afterExit)).toEqual(
      [],
    );
    expect(Date.now() - started).toBeLessThan(1500);
    expect(evidence.elapsed).toBeLessThan(1000);
    expect(evidence.rootExit.status).toBe(0);
    expect(evidence.status).toBe(0);
    expect(evidence.signal).toBe(null);
    expect(evidence.pipeCleanupTimedOut).toBe(true);
    expect(evidence.termination.attempted).toBe(true);
    expect(evidence.termination.targetPid).toBe(evidence.supervisorPid);
    expect(evidence.termination.targetPid).not.toBe(evidence.rootExit.pid);
  } finally {
    if (descendantPid > 0)
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* Test-owned process already reaped. */
      }
  }
});
