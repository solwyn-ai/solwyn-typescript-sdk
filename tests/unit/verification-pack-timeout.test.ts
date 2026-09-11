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

it("stops collecting output while simulated Windows taskkill is pending", () => {
  const program = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=(binary,args,options)=>binary==='taskkill.exe'?spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),250)'],options):spawn(binary,args,options);syncBuiltinESMExports();Object.defineProperty(process,'platform',{value:'win32'});const concat=Buffer.concat;const chunks=[];Buffer.concat=(values,...args)=>{chunks.push(values.map(value=>value.length));return concat(values,...args);};const {runBoundedCommand}=await import(${JSON.stringify(verifier)});const result=await runBoundedCommand(process.execPath,['-e',"process.stdout.on('error',()=>process.exit(0));const timer=setInterval(()=>process.stdout.write('xxxxxxxx'),1);setTimeout(()=>{clearInterval(timer);process.exit(0);},500);"],{timeout:1500,maxBuffer:1});process.stdout.write(JSON.stringify({error:result.error?.code,stdout:result.stdout,chunks,termination:result.termination}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 2500,
    killSignal: "SIGKILL",
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.error).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(result.stdout).toBe("x");
  expect(result.termination.method).toBe("taskkill-supervisor-tree");
  expect(result.chunks).toEqual([[1], []]);
});

it("lets Windows taskkill finish walking descendants after the anchor exits", () => {
  const program = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;let anchor;let helperKills=0;cp.spawn=(binary,args,options)=>{if(binary!=='taskkill.exe'){const child=spawn(binary,args,options);anchor??=child;return child;}const helper=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),250)'],options);const kill=helper.kill.bind(helper);helper.kill=(...args)=>{helperKills++;return kill(...args);};setTimeout(()=>anchor.kill('SIGKILL'),30);return helper;};syncBuiltinESMExports();Object.defineProperty(process,'platform',{value:'win32'});const {runBoundedCommand}=await import(${JSON.stringify(verifier)});const started=Date.now();const result=await runBoundedCommand(process.execPath,['-e',"process.stdout.on('error',()=>process.exit(0));const timer=setInterval(()=>process.stdout.write('xxxxxxxx'),1);setTimeout(()=>{clearInterval(timer);process.exit(0);},500);"],{timeout:1500,maxBuffer:1});process.stdout.write(JSON.stringify({elapsed:Date.now()-started,helperKills,error:result.error?.code,termination:result.termination,supervisorExit:result.supervisorExit}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 2500,
    killSignal: "SIGKILL",
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.error).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(result.supervisorExit.signal).toBe("SIGKILL");
  expect(result.helperKills).toBe(0);
  expect(result.elapsed).toBeGreaterThanOrEqual(250);
  expect(result.termination.status).toBe(0);
  expect(result.termination.completed).toBe(true);
});

it("bounds sustained high-volume output with a shared stdout/stderr cap", () => {
  const program = `import {runBoundedCommand} from ${JSON.stringify(verifier)};const result=await runBoundedCommand(process.execPath,['-e',"const chunk=Buffer.alloc(65536,120);function flood(){while(process.stdout.write(chunk)&&process.stderr.write(chunk)){}process.stdout.once('drain',flood);process.stderr.once('drain',flood);}flood();setInterval(()=>{},1000);"],{timeout:2000,maxBuffer:131072});process.stdout.write(JSON.stringify({...result,error:result.error?.code}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 4000,
    killSignal: "SIGKILL",
    maxBuffer: 262144,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.error).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(131072);
  expect(result.elapsedMs).toBeLessThan(1500);
  expect(result.termination.targetPid).toBe(result.supervisorPid);
});

it.each([
  [
    "tar",
    { status: null, error: { code: "ENOENT" } },
    {
      phase: "prerequisite",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ENOENT",
    },
  ],
  [
    "tar",
    { status: null, error: { code: "EACCES" } },
    {
      phase: "prerequisite",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "EACCES",
    },
  ],
  [
    "tar",
    { status: 2, stderr: "tar: Error opening archive: Unrecognized archive format" },
    {
      phase: "verification",
      kind: "command-failure",
      retryable: false,
      artifactFailure: true,
      errorCode: null,
    },
  ],
  [
    "npm",
    { status: null, timedOut: true, error: { code: "ETIMEDOUT" } },
    {
      phase: "dependency-setup",
      kind: "timeout",
      retryable: true,
      artifactFailure: false,
      errorCode: "ETIMEDOUT",
    },
  ],
  [
    "npm",
    { status: 1, timedOut: false, stderr: "npm error code ECONNRESET" },
    {
      phase: "dependency-setup",
      kind: "network",
      retryable: true,
      artifactFailure: false,
      errorCode: "ECONNRESET",
    },
  ],
  [
    "npm",
    { status: 1, timedOut: false, stderr: "npm error code ENOTFOUND" },
    {
      phase: "dependency-setup",
      kind: "network",
      retryable: true,
      artifactFailure: false,
      errorCode: "ENOTFOUND",
    },
  ],
  [
    "npm",
    { status: 1, timedOut: false, stderr: "npm error code ERESOLVE" },
    {
      phase: "dependency-setup",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ERESOLVE",
    },
  ],
  [
    "node",
    { status: 1, timedOut: false, stderr: "AssertionError: missing export" },
    {
      phase: "verification",
      kind: "command-failure",
      retryable: false,
      artifactFailure: true,
      errorCode: null,
    },
  ],
  [
    "npm",
    { status: null, error: { code: "ENOENT" } },
    {
      phase: "dependency-setup",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ENOENT",
    },
  ],
  [
    "npm",
    { status: 1, stderr: "npm ERR! code ERESOLVE" },
    {
      phase: "dependency-setup",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ERESOLVE",
    },
  ],
  [
    "npm",
    { status: 1, errorCode: "EAI_AGAIN", stderr: "resolver unavailable" },
    {
      phase: "dependency-setup",
      kind: "network",
      retryable: true,
      artifactFailure: false,
      errorCode: "EAI_AGAIN",
    },
  ],
])("classifies command evidence for %s", (binary, result, expected) => {
  const program = `import {classifyCommandFailure} from ${JSON.stringify(verifier)};process.stdout.write(JSON.stringify(classifyCommandFailure(${JSON.stringify(binary)},${JSON.stringify(result)})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(expected);
});

it("classifies an actually missing tar executable as a prerequisite failure", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-missing-tar-"));
  temporary.push(scratch);
  const binary = path.join(scratch, "missing", process.platform === "win32" ? "tar.exe" : "tar");
  const program = `import {runBoundedCommand,classifyCommandFailure} from ${JSON.stringify(verifier)};const binary=${JSON.stringify(binary)};const result=await runBoundedCommand(binary,['-tzf','unused.tgz'],{timeout:1000});process.stdout.write(JSON.stringify({code:result.error?.code,status:result.status,failure:classifyCommandFailure(binary,result)}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.code).toBe("ENOENT");
  expect(result.status).toBeNull();
  expect(result.failure).toMatchObject({
    phase: "prerequisite",
    artifactFailure: false,
    retryable: false,
    errorCode: "ENOENT",
  });
});

it.each([
  "ignored-signal",
  "inherited-pipe",
  "escaped-session",
])("bounds the caller despite %s", async (mode) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-pack-timeout-"));
  temporary.push(scratch);
  const child = path.join(scratch, "unresponsive.cjs");
  const descendant = path.join(scratch, "descendant.cjs");
  const heartbeat = path.join(scratch, "heartbeat.txt");
  writeFileSync(
    descendant,
    `process.on('SIGTERM',()=>{});process.stdout.write('descendant-pid:'+process.pid+'\\n');let count=0;setInterval(()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${heartbeat}.next`)},String(++count));fs.renameSync(${JSON.stringify(`${heartbeat}.next`)},${JSON.stringify(heartbeat)});},20);setTimeout(()=>process.exit(0),2500);`,
  );
  writeFileSync(
    child,
    mode === "ignored-signal"
      ? "process.on('SIGTERM',()=>{});process.stdout.write('child-ready\\n');process.stderr.write('diagnostic\\n');setTimeout(()=>process.exit(0),2500);"
      : `require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'inherit',detached:${mode === "escaped-session"}});process.stdout.write('child-ready\\n');process.stderr.write('diagnostic\\n');process.exit(0);`,
  );
  const resultFile = path.join(scratch, "result.json");
  const caller = path.join(scratch, "caller.mjs");
  writeFileSync(
    caller,
    `import fs from 'node:fs';import {runBoundedCommand} from ${JSON.stringify(verifier)};const start=Date.now();const result=await runBoundedCommand(process.execPath,[${JSON.stringify(child)}],{cwd:${JSON.stringify(scratch)},env:process.env,encoding:'utf8',timeout:200,maxBuffer:1048576});fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({elapsed:Date.now()-start,...result,error:result.error?.message??result.error}));`,
  );
  const start = Date.now();
  const result = spawnSync(process.execPath, [caller], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(Date.now() - start).toBeLessThan(1500);
  const evidence = JSON.parse(readFileSync(resultFile, "utf8"));
  expect(evidence.elapsed).toBeLessThan(1000);
  expect(evidence.timedOut).toBe(true);
  expect(evidence.stdout).toContain("child-ready");
  expect(evidence.stderr).toContain("diagnostic");
  if (mode !== "ignored-signal") {
    const pid = Number(/descendant-pid:(\d+)/.exec(evidence.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);
    try {
      const before = Number(readFileSync(heartbeat, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const after = Number(readFileSync(heartbeat, "utf8"));
      if (mode === "inherited-pipe" && process.platform !== "win32") {
        expect(after, "ordinary inherited-pipe descendant kept running after group cleanup").toBe(
          before,
        );
        expect(evidence.termination.attempted).toBe(true);
      } else {
        expect(evidence.termination.scope).toContain("escaped sessions are not contained");
        // POSIX new sessions intentionally escape the owned group; the caller still returned.
        if (mode === "escaped-session" && process.platform !== "win32")
          expect(after).toBeGreaterThan(before);
      }
    } finally {
      // The test owns this exact child PID and explicitly cleans up its deliberate escape.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already terminated/reaped. */
      }
    }
  }
});
