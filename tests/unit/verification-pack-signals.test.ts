import { spawn } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const support = new URL("../../scripts/verification/support.mjs", import.meta.url).href;
const processModule = new URL("../../scripts/verification/process.mjs", import.meta.url).href;
const temporary: string[] = [];
// Windows process.kill does not exercise catchable POSIX/console-event delivery.
// Native Windows console-event semantics are NOT RUN; taskkill/IPC simulations live separately.
const posixSignal = it.skipIf(process.platform === "win32");
const repository = fileURLToPath(new URL("../../", import.meta.url));
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

posixSignal.each([
  ["SIGINT", "active-report"],
  ["SIGTERM", "active-report"],
  ["SIGINT", "default-pack"],
  ["SIGTERM", "default-pack"],
] as const)("does not recreate active output roots after %s in %s", async (signal, mode) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-active-signal-"));
  temporary.push(scratch);
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "abc");
  const ready = path.join(scratch, "ready");
  const receipt = path.join(scratch, "roots.json");
  const preload = path.join(scratch, "preload.mjs");
  const pending = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  writeFileSync(
    preload,
    `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const roots=[];const mkdtemp=fs.mkdtempSync;fs.mkdtempSync=(...args)=>{const root=mkdtemp(...args);roots.push(root);fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(roots));return root;};const spawn=cp.spawn;cp.spawn=(binary,args,options)=>{if(args?.[0]==='-e'&&args[2]){const command=JSON.parse(args[2]);if(command.binary==='npm')return spawn(binary,[args[0],args[1],JSON.stringify({binary:process.execPath,args:['-e',${JSON.stringify(pending)}]})],options);}return spawn(binary,args,options);};syncBuiltinESMExports();`,
  );
  const program = `import fs from 'node:fs';import path from 'node:path';import {createReport,createTemporaryRoot,writeReport} from ${JSON.stringify(support)};const root=createTemporaryRoot('solwyn-active-',undefined,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)},SMOKE_KEEP:'0'}});const report=createReport({probe:'package-consumers',tarball:${JSON.stringify(artifact)}});writeReport(path.join(root,'package-consumers.json'),report);fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify([root]));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  const args =
    mode === "default-pack"
      ? [
          "--import",
          pathToFileURL(preload).href,
          path.join(repository, "scripts/pack-smoke.mjs"),
          "--tarball",
          artifact,
        ]
      : ["--input-type=module", "--eval", program];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SMOKE_KEEP: "0" },
  });
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  try {
    const deadline = Date.now() + 2000;
    while (
      !existsSync(ready) &&
      Date.now() < deadline &&
      child.exitCode === null &&
      child.signalCode === null
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready), stderr).toBe(true);
    const roots = JSON.parse(readFileSync(receipt, "utf8")) as string[];
    temporary.push(...roots);
    expect(roots.length).toBeGreaterThanOrEqual(mode === "default-pack" ? 2 : 1);
    child.kill(signal);
    const result = await exited;
    expect(result.signal).toBe(signal);
    for (const root of roots) expect(existsSync(root), root).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

posixSignal.each(["SIGINT", "SIGTERM"] as const)(
  "does not recreate finalized report paths after %s",
  async (signal) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "verification-finalized-signal-"));
    temporary.push(scratch);
    const artifact = path.join(scratch, "artifact.tgz");
    writeFileSync(artifact, "abc");
    const program = `import path from 'node:path';import {createReport,createTemporaryRoot,cleanupTemporaryRoot,finalizeReport} from ${JSON.stringify(support)};const root=createTemporaryRoot('solwyn-finalized-',undefined,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)},SMOKE_KEEP:'0'}});const report=createReport({probe:'package-consumers',tarball:${JSON.stringify(artifact)},env:{SMOKE_KEEP:'0'}});report.status='pass';finalizeReport(report,path.join(root,'package-consumers.json'));cleanupTemporaryRoot(root);process.stdout.write(JSON.stringify({root})+'\\n');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SMOKE_KEEP: "0" },
    });
    let output = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing readiness: ${stderr}`)), 2000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          if (!output.includes("\n")) reject(new Error(`Exited before readiness: ${stderr}`));
        });
      });
      const { root } = JSON.parse(output);
      expect(existsSync(root)).toBe(false);
      child.kill(signal);
      const result = await exited;
      expect(result.signal).toBe(signal);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(path.join(root, "package-consumers.json"))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
);

posixSignal.each(["second-signal", "teardown-deadline"])(
  "bounds interrupted cleanup on %s",
  async (mode) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "verification-signal-bound-"));
    temporary.push(scratch);
    const artifact = path.join(scratch, "artifact.tgz");
    writeFileSync(artifact, "abc");
    const file = path.join(scratch, "report.json");
    const program = `import fs from 'node:fs';import {createReport,createTemporaryRoot,writeReport} from ${JSON.stringify(support)};const report=createReport({probe:'signal-probe',tarball:${JSON.stringify(artifact)}});createTemporaryRoot('solwyn-signal-bound-',report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)}}});writeReport(${JSON.stringify(file)},report);fs.promises.rm=()=>{process.stdout.write('CLEANING');return new Promise(()=>{});};process.stdout.write('READY');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SMOKE_KEEP: "0" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const waitFor = async (token: string) => {
      const deadline = Date.now() + 2000;
      while (
        !output.includes(token) &&
        Date.now() < deadline &&
        child.exitCode === null &&
        child.signalCode === null
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(output).toContain(token);
    };
    try {
      await waitFor("READY");
      const start = Date.now();
      child.kill("SIGTERM");
      await waitFor("CLEANING");
      if (mode === "second-signal") child.kill("SIGINT");
      const result = await exited;
      expect(Date.now() - start).toBeLessThan(3000);
      if (process.platform !== "win32") expect(result.signal).toBe("SIGTERM");
      else expect(result.code).not.toBe(0);
      const report = JSON.parse(readFileSync(file, "utf8"));
      expect(report.failure).toMatchObject({ phase: "signal", errorCode: "SIGTERM" });
      expect(report.cleanup.failure).toMatchObject({
        phase: "cleanup",
        kind: mode === "second-signal" ? "interrupted" : "timeout",
      });
      expect(report.cleanup.roots[0]).toMatchObject({ state: "cleanup-failed", retained: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
);

posixSignal.each(["SIGINT", "SIGTERM"] as const)(
  "cleans aggregate containers and nested anchors on a real %s",
  async (signal) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "verification-aggregate-signal-"));
    temporary.push(scratch);
    const scripts = path.join(scratch, "repo/scripts/verification");
    mkdirSync(scripts, { recursive: true });
    for (const file of ["artifact-identity.mjs", "run.mjs", "support.mjs", "process.mjs"])
      copyFileSync(path.join(repository, "scripts/verification", file), path.join(scripts, file));
    const artifact = path.join(scratch, "artifact.tgz");
    writeFileSync(artifact, "abc");
    const out = path.join(scratch, "output");
    const ready = path.join(scratch, "ready.json");
    const command = "process.stdout.write('READY:'+process.pid+'\\n');setInterval(()=>{},1000);";
    writeFileSync(
      path.join(scripts, "package-consumers.mjs"),
      `import fs from 'node:fs';import path from 'node:path';import {createReport,createTemporaryRoot,writeReport} from './support.mjs';import {spawnCommandSupervisor} from './process.mjs';const tarball=process.argv[process.argv.indexOf('--tarball')+1];const report=createReport({probe:'package-consumers',tarball});const root=createTemporaryRoot('solwyn-signal-child-',report);writeReport(${JSON.stringify(path.join(out, "package-consumers.json"))},report);const anchor=spawnCommandSupervisor(process.execPath,['-e',${JSON.stringify(command)}],{cwd:root});anchor.stdout.on('data',data=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({root,pid:Number(/READY:(\\d+)/.exec(String(data))?.[1])})));anchor.stderr.resume();`,
    );
    const child = spawn(
      process.execPath,
      [path.join(scripts, "run.mjs"), "--tarball", artifact, "--out", out],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      const deadline = Date.now() + 2000;
      while (
        !existsSync(ready) &&
        Date.now() < deadline &&
        child.exitCode === null &&
        child.signalCode === null
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(ready), stderr).toBe(true);
      const launched = JSON.parse(readFileSync(ready, "utf8"));
      const started = Date.now();
      child.kill(signal);
      const exit = await exited;
      expect(Date.now() - started).toBeLessThan(2500);
      if (process.platform !== "win32") expect(exit.signal).toBe(signal);
      else expect(exit.code).not.toBe(0);
      const result = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8"));
      expect(result.failure).toMatchObject({ phase: "signal", errorCode: signal });
      expect(result.status).toBe("fail");
      expect(result.cleanup.roots).toHaveLength(1);
      expect(result.cleanup.roots[0]).toMatchObject({ state: "removed", retained: false });
      expect(existsSync(result.cleanup.roots[0].path)).toBe(false);
      expect(existsSync(launched.root)).toBe(false);
      expect(existsSync(scratch)).toBe(true);
      expect(() => process.kill(launched.pid, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
);

posixSignal.each(["SIGINT", "SIGTERM"] as const)(
  "cleans direct lifecycle roots and anchors before preserving %s",
  async (signal) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "verification-signals-"));
    temporary.push(scratch);
    const artifact = path.join(scratch, "artifact.tgz");
    writeFileSync(artifact, "abc");
    const resultFile = path.join(scratch, "report.json");
    const command = "process.stdout.write('READY:'+process.pid+'\\n');setInterval(()=>{},1000);";
    const program = `import {createReport,createTemporaryRoot,writeReport} from ${JSON.stringify(support)};import {spawnCommandSupervisor} from ${JSON.stringify(processModule)};const report=createReport({probe:'signal-probe',tarball:${JSON.stringify(artifact)}});const root=createTemporaryRoot('solwyn-signal-',report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(scratch)}}});report.details.untrustedRoot=${JSON.stringify(scratch)};writeReport(${JSON.stringify(resultFile)},report);const anchor=spawnCommandSupervisor(process.execPath,['-e',${JSON.stringify(command)}],{cwd:root});anchor.stdout.pipe(process.stdout);anchor.stderr.pipe(process.stderr);`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SMOKE_KEEP: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No readiness marker: ${stderr}`)), 2000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes("READY:")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          if (!stdout.includes("READY:")) reject(new Error(`Exited before readiness: ${stderr}`));
        });
      });
      const started = Date.now();
      child.kill(signal);
      const result = await exited;
      expect(Date.now() - started).toBeLessThan(2500);
      if (process.platform !== "win32") expect(result.signal).toBe(signal);
      else expect(result.code).not.toBe(0);
      const report = JSON.parse(readFileSync(resultFile, "utf8"));
      expect(report.status).toBe("fail");
      expect(report.failure).toMatchObject({
        phase: "signal",
        kind: "interrupted",
        errorCode: signal,
      });
      expect(report.cleanup.failure).toBeNull();
      expect(report.cleanup.roots[0]).toMatchObject({ state: "removed", retained: false });
      expect(existsSync(report.cleanup.roots[0].path)).toBe(false);
      expect(existsSync(scratch)).toBe(true);
      const pid = Number(/READY:(\d+)/.exec(stdout)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
);
