import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.each([
  "term-ignored",
  "inherited-pipe",
])("bounds browser --version with %s and removes its real tree", async (scenario) => {
  const out = mkdtempSync(path.join(tmpdir(), "task3-browser-version-"));
  roots.push(out);
  const tarball = path.join(out, "artifact.tgz");
  const bundle = path.join(out, "edge-browser-bundle.js");
  const fixture = path.join(out, "version.mjs");
  const hooks = path.join(out, "version-hook.mjs");
  const recordFile = path.join(out, "version-processes.json");
  writeFileSync(tarball, "version prerequisite only");
  writeFileSync(bundle, "version prerequisite only");
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
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
    fixture,
    `
    import {spawn} from 'node:child_process';import fs from 'node:fs';import {once} from 'node:events';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},20);"],{stdio:['ignore','inherit','inherit','ipc']});
    await once(child,'message');child.disconnect();child.unref();
    fs.writeFileSync(process.env.VERSION_PROCESS_RECORD,JSON.stringify({pid:process.pid,descendant:child.pid}));
    if(process.env.VERSION_SCENARIO==='inherited-pipe'){process.stdout.write('Synthetic Chrome 1.0');process.exit(0);}
    setInterval(()=>{},20);
  `,
  );
  writeFileSync(
    hooks,
    `
    import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    const spawn=cp.spawn,spawnSync=cp.spawnSync;
    cp.spawn=(binary,args,options)=>args[0]==='--version'?spawn(process.execPath,[process.env.VERSION_FIXTURE],options):spawn(binary,args,options);
    cp.spawnSync=(binary,args,options)=>args[0]==='--version'?spawnSync(process.execPath,[process.env.VERSION_FIXTURE],{...options,timeout:150}):spawnSync(binary,args,options);
    const timeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timeout(fn,ms===10000?150:ms,...args);
    syncBuiltinESMExports();
  `,
  );
  const script = fileURLToPath(
    new URL("../../scripts/verification/browser-proof.mjs", import.meta.url),
  );
  const probe = spawn(process.execPath, [script, "--tarball", tarball, "--out", out], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(hooks).href}`,
      VERSION_FIXTURE: fixture,
      VERSION_PROCESS_RECORD: recordFile,
      VERSION_SCENARIO: scenario,
      SOLWYN_VERIFICATION_BROWSER: process.execPath,
    },
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  let watchdogFired = false;
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        if (probe.exitCode === null && probe.signalCode === null) {
          if (process.platform !== "win32" && probe.pid) process.kill(-probe.pid, "SIGKILL");
          else probe.kill("SIGKILL");
        }
      }, 1600);
      probe.once("exit", (code, signal) => {
        clearTimeout(watchdog);
        resolve({ code, signal });
      });
    },
  );
  const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : undefined;
  for (let index = 0; record && index < 30 && [record.pid, record.descendant].some(alive); index++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const survivors = record ? [record.pid, record.descendant].filter(alive) : [];
  for (const pid of survivors) process.kill(pid, "SIGKILL");
  expect(
    watchdogFired,
    "synchronous --version escaped its deadline and required outer rescue",
  ).toBe(false);
  expect(record).toBeDefined();
  expect(survivors, "browser version helper survived bounded cleanup").toEqual([]);
  expect(status).toEqual({ code: 1, signal: null });
  const report = JSON.parse(readFileSync(path.join(out, "browser-proof.json"), "utf8"));
  expect(report.failure).toMatchObject({
    phase: "environment",
    kind: "prerequisite",
    artifactFailure: false,
  });
  expect(report.cleanup.roots).toEqual([]);
  expect(report.details.commands[0]).toMatchObject({
    state: "finished",
    termination: { attempted: true },
  });
}, 5000);
