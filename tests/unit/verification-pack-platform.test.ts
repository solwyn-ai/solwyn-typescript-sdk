import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const verifier = new URL("../../scripts/verification/process.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("does not substitute a pnpm invoker when npm was requested", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verification-pack-platform-"));
  temporary.push(root);
  const npm = path.join(root, "node_modules/npm/bin/npm-cli.js");
  const pnpm = path.join(root, "pnpm.cjs");
  mkdirSync(path.dirname(npm), { recursive: true });
  writeFileSync(npm, "");
  writeFileSync(pnpm, "");
  const program = `import {resolvePackageManagerCommand} from ${JSON.stringify(verifier)};process.stdout.write(JSON.stringify(resolvePackageManagerCommand('npm',['install'],{platform:'win32',env:{npm_execpath:${JSON.stringify(pnpm)},PATH:${JSON.stringify(root)}},execPath:${JSON.stringify(path.join(root, "node.exe"))}})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout).args).toEqual([npm, "install"]);
});

it.each([
  "npm",
  "pnpm",
])("launches the Windows %s script with literal argv and no shell", (manager) => {
  const root = mkdtempSync(path.join(tmpdir(), "verification-pack-platform-"));
  temporary.push(root);
  const bin = path.join(root, "toolchain");
  const script = path.join(
    bin,
    "node_modules",
    manager,
    "bin",
    manager === "npm" ? "npm-cli.js" : "pnpm.cjs",
  );
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const args = ["a & b", "%USERPROFILE%", 'quote"literal', "$(literal)"];
  const caller = path.join(root, "caller.mjs");
  writeFileSync(
    caller,
    `import {runBoundedCommand} from ${JSON.stringify(verifier)};Object.defineProperty(process,'platform',{value:'win32'});const result=await runBoundedCommand(${JSON.stringify(manager)},${JSON.stringify(args)},{env:{...process.env,PATH:${JSON.stringify(bin)},npm_execpath:${JSON.stringify(script)}},timeout:1000});process.stdout.write(JSON.stringify({...result,error:result.error?.message}));`,
  );
  const child = spawnSync(process.execPath, [caller], { encoding: "utf8", timeout: 3000 });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.status, result.error).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(args);
});
