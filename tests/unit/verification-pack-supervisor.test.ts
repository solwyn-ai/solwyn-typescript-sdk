import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const verifier = new URL("../../scripts/verification/process.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32").each(["disconnect", "disconnect-throws"])(
  "exits the caller after POSIX group-kill failure with %s fallback",
  (mode) => {
    const program = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);if(${JSON.stringify(mode)}==='disconnect-throws')child.disconnect=()=>{throw new Error('injected disconnect failure');};return child;};syncBuiltinESMExports();const kill=process.kill;process.kill=(pid,...args)=>{if(pid<0)throw Object.assign(new Error('injected group kill EPERM'),{code:'EPERM'});return kill(pid,...args);};const {runBoundedCommand}=await import(${JSON.stringify(verifier)});const result=await runBoundedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:100});process.stdout.write(JSON.stringify({...result,error:result.error?.code}));`;
    const start = Date.now();
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(Date.now() - start).toBeLessThan(900);
    const result = JSON.parse(child.stdout);
    expect(result.error).toBe("ETIMEDOUT");
    expect(result.termination.error).toBe("injected group kill EPERM");
    expect(result.termination.disconnectAttempted).toBe(true);
    if (mode === "disconnect-throws")
      expect(result.termination.disconnectError).toBe("injected disconnect failure");
  },
);

it.each([
  "disconnect",
  "stdout-error",
  "stderr-error",
])("cleans a live anchor on %s", async (mode) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-supervisor-"));
  temporary.push(scratch);
  const heartbeat = path.join(scratch, "heartbeat");
  const childPath = path.join(scratch, "child.cjs");
  const preload = path.join(scratch, "preload.cjs");
  writeFileSync(
    childPath,
    `let count=0;setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(heartbeat)},String(++count)),15);setTimeout(()=>process.exit(0),3000);`,
  );
  writeFileSync(
    preload,
    `const cp=require('node:child_process');const original=cp.spawn;cp.spawn=(binary,args,options)=>{const child=original(binary,args,options);if(args[0]===${JSON.stringify(childPath)}&&${JSON.stringify(mode)}!=='disconnect')setTimeout(()=>child[${JSON.stringify(mode.split("-")[0])}].emit('error',new Error('injected source pipe error')),150);return child;};require('node:module').syncBuiltinESMExports();`,
  );
  const caller = path.join(scratch, "caller.mjs");
  const evidencePath = path.join(scratch, "result.json");
  writeFileSync(
    caller,
    `import fs from 'node:fs';import {spawnCommandSupervisor} from ${JSON.stringify(verifier)};const anchor=spawnCommandSupervisor(process.execPath,[${JSON.stringify(childPath)}],{env:{...process.env,NODE_OPTIONS:'--require '+${JSON.stringify(preload)}}});anchor.stdout.resume();anchor.stderr.resume();anchor.on('message',message=>{if(message.type==='started'&&${JSON.stringify(mode)}==='disconnect')setTimeout(()=>anchor.disconnect(),150);});await new Promise(resolve=>anchor.once('exit',(status,signal)=>{fs.writeFileSync(${JSON.stringify(evidencePath)},JSON.stringify({status,signal}));resolve();}));`,
  );
  const child = spawnSync(process.execPath, [caller], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
  });
  expect(child.status, child.stderr).toBe(0);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (process.platform === "win32") expect(evidence.status).not.toBe(0);
  else expect(evidence.signal).toBe("SIGKILL");
  const before = readFileSync(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(readFileSync(heartbeat, "utf8")).toBe(before);
});

it("returns structured failure when the finish IPC send throws synchronously", () => {
  const program = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;cp.spawn=(...args)=>{const child=original(...args);child.send=()=>{throw Object.assign(new Error('injected closed channel'),{code:'ERR_IPC_CHANNEL_CLOSED'});};return child;};syncBuiltinESMExports();const {runBoundedCommand}=await import(${JSON.stringify(verifier)});const result=await runBoundedCommand(process.execPath,['-e','process.exit(0)'],{timeout:1000});process.stdout.write(JSON.stringify({...result,error:result.error?.code}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.error).toBe("ERR_VERIFICATION_SUPERVISOR_CHANNEL");
  expect(result.rootExit.status).toBe(0);
  expect(result.termination.attempted).toBe(true);
});

it("fails if a supervisor exits unexpectedly after the actual command succeeded", () => {
  const source = readFileSync(fileURLToPath(verifier), "utf8");
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-supervisor-exit-"));
  temporary.push(scratch);
  const helper = path.join(scratch, "helper.mjs");
  // Inject an unexpected anchor exit after sending actual exit evidence, before closed/finish.
  writeFileSync(
    helper,
    source.replace(
      'void exitMessage.then(() => send({ type: "closed" }));',
      "void exitMessage.then(() => process.exit(2));",
    ),
  );
  const program = `const {runBoundedCommand}=await import(${JSON.stringify(pathToFileURL(helper).href)});const result=await runBoundedCommand(process.execPath,['-e','process.exit(0)'],{timeout:1000});process.stdout.write(JSON.stringify({...result,error:result.error?.code}));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.rootExit.status).toBe(0);
  expect(result.status).toBeNull();
  expect(result.error).toBe("ERR_VERIFICATION_SUPERVISOR_EXIT");
});
