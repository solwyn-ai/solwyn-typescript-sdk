import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/verification/browser-proof.mjs", import.meta.url),
);
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Fault-inject only the process/CDP boundary. Execute the actual CLI, result writer,
// shutdown checks and connection deadlines. The real-browser probe is separate.
const browserProcess = `
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
const profile=process.argv[1];
let descendant;
if(['descendant','cdp-malformed','cdp-malformed-inherited','cdp-nonstring','cdp-between-commands','cdp-bad-error','cdp-transport-reset','stderr-flood'].includes(process.env.BROWSER_FAULT)) {
  descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);"],{stdio:['ignore','pipe','ignore']});
  await once(descendant.stdout,'data');
  descendant.stdout.destroy();
  descendant.unref();
}
const server=net.createServer({allowHalfOpen:true},socket=>socket.on('data',()=>{}));
server.listen(0,'127.0.0.1',()=>{
  fs.writeFileSync(path.join(profile,'DevToolsActivePort'),String(server.address().port));
  fs.writeFileSync(process.env.BROWSER_PROCESS_RECORD,JSON.stringify({pid:process.pid,profile,descendantPid:descendant?.pid}));
  if(process.env.BROWSER_FAULT==='stderr-flood') setTimeout(()=>process.stderr.write(Buffer.alloc(2*1024*1024,120)),25);
});
process.on('SIGTERM',()=>{});
`;
const preload = `
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
const scenario = process.env.BROWSER_FAULT;
if(scenario.startsWith('windows-tree-')) Object.defineProperty(process,'platform',{value:'win32'});
const realBrowser = ['unresponsive-browser','term-ignored','term-forced','descendant','cdp-malformed','cdp-malformed-inherited','cdp-nonstring','cdp-between-commands','cdp-bad-error','cdp-transport-reset','stderr-flood'].includes(scenario);
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 10000 ? 500 : ms >= 1000 ? 25 : ms, ...args);
let child;
let profile;
const realSpawn = childProcess.spawn;
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (binary,args,options) => {
  if(String(binary).toLowerCase()==='taskkill.exe' && scenario!=='unresponsive-browser') return realSpawnSync(binary,args,options);
  return { status: 0, stdout: 'Fault injected Chromium', stderr: '' };
};
childProcess.spawn = (_binary, args, options) => {
  if(String(_binary).toLowerCase()==='taskkill.exe') {
    if(realBrowser && scenario!=='unresponsive-browser') return realSpawn(_binary,args,options);
    const killer=new EventEmitter();
    killer.exitCode=null;killer.signalCode=null;killer.unref=()=>{};
    killer.kill=()=>{killer.signalCode='SIGKILL';};
    if(scenario!=='windows-tree-timeout') queueMicrotask(()=>{if(scenario!=='unresponsive-browser')child.kill('SIGKILL');killer.exitCode=scenario==='windows-tree-failure'?1:0;killer.emit('exit',killer.exitCode);});
    return killer;
  }
  // A NODE_OPTIONS preload is inherited by the version anchor and fixture
  // descendants. Only intercept the parent's serialized supervisor envelope;
  // ordinary Node/version/helper launches must retain their actual argv.
  if(_binary!==process.execPath || args[0]!=='-e') return realSpawn(_binary,args,options);
  let command;
  try { command=JSON.parse(args.at(-1)); } catch { return realSpawn(_binary,args,options); }
  if(!command || typeof command.binary!=='string' || !Array.isArray(command.args)) return realSpawn(_binary,args,options);
  if(command.args[0]==='--version') return realSpawn(_binary,[...args.slice(0,-1),JSON.stringify({binary:process.execPath,args:['-e',"process.stdout.write('Fault injected Chromium')"]})],options);
  const profileArgument=command.args.find(arg=>typeof arg==='string' && arg.startsWith('--user-data-dir='));
  if(!profileArgument) return realSpawn(_binary,args,options);
  args=command.args;
  profile = profileArgument.slice('--user-data-dir='.length);
  let registration;
  try { registration=JSON.parse(readFileSync(path.join(path.dirname(process.env.BROWSER_REGISTRATION_RECORD),'browser-proof.json'),'utf8')); } catch {}
  writeFileSync(process.env.BROWSER_REGISTRATION_RECORD,JSON.stringify({registered:registration?.details?.profile===profile,status:registration?.status}));
  if (realBrowser) {
    child = realSpawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(browserProcess)},
      profile], { stdio: ['ignore','ignore',options.stdio[2]], env: process.env, detached: options.detached });
    child.once('exit',(status,signal)=>child.emit('message',{type:'exit',status,signal,pid:child.pid}));
    // Model an unreapable browser: the OS signal boundary does not deliver exit.
    if (scenario === 'unresponsive-browser') child.kill = () => true;
    if (scenario === 'term-forced') {
      const kill = child.kill.bind(child);
      // Exercise immediate TERM termination on POSIX too, without pretending
      // that a Windows machine ran this test or changing process.platform.
      child.kill = signal => kill(signal === 'SIGTERM' ? 'SIGKILL' : signal);
    }
    const kill = process.kill.bind(process);
    process.kill = (pid,signal) => {
      if(pid===-child.pid && signal!==0) {
        if(scenario==='unresponsive-browser') return true;
        if(scenario==='term-forced' && signal==='SIGTERM') return kill(pid,'SIGKILL');
      }
      return kill(pid,signal);
    };
    return child;
  }
  child = new EventEmitter();
  child.pid=process.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null, signal); };
  child.unref = () => {};
  const kill=process.kill.bind(process);
  process.kill=(pid,signal)=>{
    if(pid===-child.pid) {
      if(scenario==='known-root-exit') writeFileSync(process.env.BROWSER_SIGNAL_RECORD,String(signal));
      child.kill(signal);return true;
    }
    return kill(pid,signal);
  };
  writeFileSync(path.join(profile, 'DevToolsActivePort'), '12345\\n');
  return child;
};
syncBuiltinESMExports();
globalThis.fetch = (_url, options) => {
  if (scenario === 'http') return new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const port = realBrowser ? readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim() : '12345';
  return Promise.resolve(Response.json([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:'+port+'/page' }]));
};
globalThis.WebSocket = class extends EventTarget {
  constructor(url) {
    super();
    if (realBrowser) {
      this.transport = net.connect(Number(new URL(url).port),'127.0.0.1',()=>this.dispatchEvent(new Event('open')));
      this.transport.on('error',()=>this.dispatchEvent(new Event('error')));
    } else if (scenario !== 'websocket') queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  close() {
    this.transport?.end();
    if(scenario==='cleanup-anchor-exit') {child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);}
  }
  send(payload) {
    const { id, method, params } = JSON.parse(payload);
    let result = {};
    if (method === 'Runtime.evaluate') {
      const value = params.expression === 'Boolean(globalThis.reviewDone)' ? true
        : params.expression === 'globalThis.reviewDone' ? { ok:true,providerCalls:2,checks:4,confirms:4,transmittedEvents:4,uniqueCalls:4,ingested:4,legacyDedupCollisions:0,unexpectedFetch:0,ambientRunAbsent:true,nodeGlobalAbsent:true,bufferAbsent:true,coreClosed:{checks:2,confirms:2,ingested:2},warnings:[] }
        : '<html></html>';
      result = { result: { value } };
      if(scenario==='descendant' && params.expression==='globalThis.reviewDone') result.exceptionDetails={text:'Synthetic internal proof failure'};
    }
    queueMicrotask(() => {
      if(scenario==='cdp-transport-reset') { this.transport.emit('error',Object.assign(new Error('Synthetic transport reset'),{code:'ECONNRESET'})); return; }
      if(scenario==='cdp-malformed'||scenario==='cdp-malformed-inherited') { this.dispatchEvent(new MessageEvent('message',{data:'{'})); return; }
      if(scenario==='cdp-nonstring') { this.dispatchEvent(new MessageEvent('message',{data:null})); return; }
      if(scenario==='cdp-bad-error') { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,error:{message:{toString:0}}})})); return; }
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) }));
      if(scenario==='cdp-between-commands' && method==='Page.enable') this.dispatchEvent(new MessageEvent('message',{data:'{'}));
      if (method === 'Browser.close' && !['exit-timeout','profile-keep'].includes(scenario) && !realBrowser) {
        if(scenario.startsWith('close-error-')) this.dispatchEvent(new Event('error'));
        const status = ['exit-one','close-error-one'].includes(scenario) ? 1 : 0;
        child.emit('message',{type:'exit',status,signal:null,pid:123});
        if(scenario==='known-root-exit') {
          child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);
        }
      }
    });
  }
};
`;

describe("browser verification lifecycle", () => {
  it.each([
    ["exit-one", "Browser must exit successfully"],
    ["exit-timeout", "Browser did not exit"],
    ["http", "DevTools HTTP startup timed out"],
    ["websocket", "DevTools WebSocket startup timed out"],
    ["unresponsive-browser", "Browser did not exit"],
    ["term-ignored", "Browser did not exit"],
    ["term-forced", "Browser did not exit"],
    ["descendant", "Browser proof rejected"],
    ["profile-keep", "Browser did not exit"],
    ["cdp-malformed", "Invalid DevTools message"],
    ["cdp-malformed-inherited", "Invalid DevTools message"],
    ["cdp-nonstring", "Invalid DevTools message"],
    ["cdp-between-commands", "Invalid DevTools message"],
    ["cdp-bad-error", "Invalid DevTools message"],
    ["cdp-transport-reset", "DevTools transport failed"],
    ["stderr-flood", "Browser stderr exceeded"],
    ["close-error-zero", ""],
    ["close-error-one", "Browser must exit successfully"],
    ["known-root-exit", "Browser supervisor exited unexpectedly"],
    ["cleanup-anchor-exit", "Browser ownership anchor was lost before cleanup"],
    ["windows-tree-failure", "Browser Windows tree cleanup was not confirmed"],
    ["windows-tree-timeout", "Browser Windows tree cleanup timed out"],
    ["windows-tree-success", ""],
  ])("handles %s", async (scenario, message) => {
    const out = mkdtempSync(path.join(tmpdir(), "task3-runtime-lifecycle-"));
    temporary.push(out);
    const parentContainer = mkdtempSync(path.join(out, "parent-owned-"));
    const tarball = path.join(out, "artifact.tgz");
    const bundle = path.join(out, "edge-browser-bundle.js");
    const hooks = path.join(out, "faults.mjs");
    const processRecord = path.join(out, "browser-process.json");
    const signalRecord = path.join(out, "former-group-signal.txt");
    const registrationRecord = path.join(out, "browser-registration.json");
    writeFileSync(tarball, "identity-only artifact");
    writeFileSync(bundle, "identity-only bundle");
    writeFileSync(hooks, preload);
    const hash = (filename: string) =>
      createHash("sha256").update(readFileSync(filename)).digest("hex");
    writeFileSync(
      path.join(out, "bundle-proofs.json"),
      JSON.stringify({
        schemaVersion: 1,
        probe: "bundle-proofs",
        status: "pass",
        artifact: { path: realpathSync(tarball), sha256: hash(tarball) },
        versions: { node: process.version },
        checks: {
          bundleSha256: hash(bundle),
        },
        details: {},
        failure: null,
        cleanup: { keepRequested: false, roots: [], failure: null },
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", hooks, script, "--tarball", tarball, "--out", out],
      {
        env: {
          ...process.env,
          ...(scenario === "cdp-malformed-inherited"
            ? { NODE_OPTIONS: `--import=${pathToFileURL(hooks).href}` }
            : {}),
          BROWSER_FAULT: scenario,
          SOLWYN_VERIFICATION_BROWSER: process.execPath,
          BROWSER_PROCESS_RECORD: processRecord,
          BROWSER_SIGNAL_RECORD: signalRecord,
          BROWSER_REGISTRATION_RECORD: registrationRecord,
          SOLWYN_VERIFICATION_TEMP_ROOT: parentContainer,
          SMOKE_KEEP: scenario === "profile-keep" ? "1" : "0",
        },
        encoding: "utf8",
        timeout: 2000,
      },
    );
    let descendantAlive = false;
    const registration = JSON.parse(readFileSync(registrationRecord, "utf8"));
    if (
      [
        "unresponsive-browser",
        "term-ignored",
        "term-forced",
        "descendant",
        "cdp-malformed",
        "cdp-malformed-inherited",
        "cdp-nonstring",
        "cdp-between-commands",
        "cdp-bad-error",
        "cdp-transport-reset",
        "stderr-flood",
      ].includes(scenario)
    ) {
      const browser = JSON.parse(readFileSync(processRecord, "utf8"));
      temporary.push(browser.profile);
      if (browser.descendantPid) {
        for (let index = 0; index < 20; index++) {
          try {
            process.kill(browser.descendantPid, 0);
            descendantAlive = true;
          } catch {
            descendantAlive = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      // The synthetic OS failure is limited to the driver; reap our real fixture.
      for (const pid of [browser.pid, browser.descendantPid].filter(Boolean)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    expect(registration, "profile ownership must be persisted before browser launch").toEqual({
      registered: true,
      status: "fail",
    });
    if (scenario === "known-root-exit")
      expect(
        existsSync(signalRecord),
        "former process group was probed or signaled after root exit",
      ).toBe(false);
    const success = ["close-error-zero", "windows-tree-success"].includes(scenario);
    expect(result.status).toBe(success ? 0 : 1);
    if (scenario.startsWith("cdp-"))
      expect(descendantAlive, "transport callback error leaked browser descendant").toBe(false);
    const report = JSON.parse(readFileSync(path.join(out, "browser-proof.json"), "utf8"));
    temporary.push(report.details.profile);
    expect(path.dirname(report.details.profile)).toBe(realpathSync(parentContainer));
    expect(report.status).toBe(success ? "pass" : "fail");
    if (message) expect(report.details.error).toContain(message);
    if (scenario === "descendant")
      expect(descendantAlive, "browser descendant survived internal proof failure").toBe(false);
    expect(existsSync(report.details.profile)).toBe(scenario === "profile-keep");
    if (scenario === "stderr-flood") {
      expect(descendantAlive).toBe(false);
      expect(statSync(path.join(out, "browser-stderr.log")).size).toBeLessThanOrEqual(1024 * 1024);
    }
    if (["exit-one", "close-error-one"].includes(scenario))
      expect(report.details.execution.exit.code).toBe(1);
    if (scenario === "unresponsive-browser") {
      expect(result.error).toBeUndefined();
      expect(report.details.cleanup).toMatchObject({
        termination: { attempted: true },
        exit: null,
        detached: true,
      });
    }
    if (["term-ignored", "term-forced"].includes(scenario)) {
      expect(result.error).toBeUndefined();
      const cleanup = report.details.cleanup;
      expect(cleanup).toMatchObject({
        termination: { attempted: true },
        detached: false,
      });
      expect(cleanup.exit).not.toBeNull();
      expect(cleanup.closed).toEqual(cleanup.anchorExit);
      expect(cleanup.exit).not.toEqual({ code: 0, signal: null });
      if (process.platform !== "win32")
        expect(cleanup.exit).toEqual({ code: null, signal: "SIGKILL" });
    }
  });

  it("reaps the real browser tree when its probe is hard-killed", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "task3-browser-parent-death-"));
    temporary.push(out);
    const container = mkdtempSync(path.join(out, "parent-owned-"));
    const tarball = path.join(out, "artifact.tgz");
    const bundle = path.join(out, "edge-browser-bundle.js");
    const hooks = path.join(out, "browser-fixture.mjs");
    const recordFile = path.join(out, "browser-process.json");
    writeFileSync(tarball, "identity-only artifact");
    writeFileSync(bundle, "identity-only bundle");
    const hash = (filename: string) =>
      createHash("sha256").update(readFileSync(filename)).digest("hex");
    writeFileSync(
      path.join(out, "bundle-proofs.json"),
      JSON.stringify({
        schemaVersion: 1,
        probe: "bundle-proofs",
        status: "pass",
        artifact: { path: realpathSync(tarball), sha256: hash(tarball) },
        versions: { node: process.version },
        checks: { bundleSha256: hash(bundle) },
        details: {},
        failure: null,
        cleanup: { keepRequested: false, roots: [], failure: null },
      }),
    );
    writeFileSync(
      hooks,
      `
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      const spawn=childProcess.spawn;
      childProcess.spawn=(binary,args,options)=>{
        const profile=args.find(arg=>arg.startsWith('--user-data-dir='));
        return profile ? spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(browserProcess)},profile.slice('--user-data-dir='.length)],options) : spawn(binary,args,options);
      };
      syncBuiltinESMExports();
      globalThis.fetch=async url=>Response.json([{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:'+new URL(url).port+'/page'}]);
      globalThis.WebSocket=class extends EventTarget {close() {}};
    `,
    );
    const probe = spawn(process.execPath, [script, "--tarball", tarball, "--out", out], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(hooks).href}`,
        BROWSER_FAULT: "descendant",
        BROWSER_PROCESS_RECORD: recordFile,
        SOLWYN_VERIFICATION_BROWSER: process.execPath,
        SOLWYN_VERIFICATION_TEMP_ROOT: container,
        SMOKE_KEEP: "0",
      },
      stdio: "ignore",
    });
    const exited = once(probe, "exit");
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let record: { pid: number; descendantPid: number; profile: string } | undefined;
    try {
      for (let index = 0; index < 160 && !existsSync(recordFile); index++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      record = JSON.parse(readFileSync(recordFile, "utf8"));
      if (!record) throw new Error("Browser process record was not written");
      expect(probe.exitCode).toBeNull();
      expect(record?.descendantPid).toBeTypeOf("number");
      const partial = JSON.parse(readFileSync(path.join(out, "browser-proof.json"), "utf8"));
      expect(partial.details.profile).toBe(record?.profile);
      probe.kill("SIGKILL");
      await exited;
      for (
        let index = 0;
        index < 120 && [record?.pid, record?.descendantPid].some((pid) => pid && alive(pid));
        index++
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(alive(record.pid), "browser survived probe death").toBe(false);
      expect(alive(record.descendantPid), "browser descendant survived probe death").toBe(false);
      expect(path.dirname(record.profile)).toBe(realpathSync(container));
      // The killed probe cannot run finally. Its exact profile stays inside the
      // parent-owned container, which the aggregate driver's own finally owns.
      expect(existsSync(record.profile)).toBe(true);
    } finally {
      if (probe.exitCode === null && probe.signalCode === null) probe.kill("SIGKILL");
      await exited;
      for (const pid of [record?.pid, record?.descendantPid])
        if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 10000);
});
