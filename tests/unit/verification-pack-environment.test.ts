import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  "pack-smoke.mjs",
  "verification/package-consumers.mjs",
])("%s removes every NODE_PATH spelling before launching a child", (script) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-pack-environment-"));
  temporary.push(scratch);
  const snapshot = path.join(scratch, "child-environment.json");
  const child = path.join(scratch, "snapshot.cjs");
  writeFileSync(
    child,
    `require('node:fs').writeFileSync(${JSON.stringify(snapshot)},JSON.stringify(Object.keys(process.env).filter(key=>key.toUpperCase()==='NODE_PATH')));process.exit(19);`,
  );
  const preload = path.join(scratch, "preload.mjs");
  // Substitute only the package-manager boundary. A real child receives the driver's actual env.
  writeFileSync(
    preload,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
for(const name of ['spawn','spawnSync','execFileSync']){const original=cp[name];cp[name]=(binary,args,options)=>{if(args?.[0]==='-e'&&args[2]){try{const command=JSON.parse(args[2]);if(command.binary==='npm'||command.binary==='pnpm')return original(binary,[args[0],args[1],JSON.stringify({binary:process.execPath,args:[${JSON.stringify(child)}]})],options);}catch{}}return original(binary==='npm'||binary==='pnpm'?process.execPath:binary,binary==='npm'||binary==='pnpm'?[${JSON.stringify(child)}]:args,options);};}syncBuiltinESMExports();`,
  );
  const artifact = path.join(scratch, "artifact.tgz");
  writeFileSync(artifact, "artifact intentionally never installed");
  const args = ["--import", pathToFileURL(preload).href, path.join(repository, "scripts", script)];
  if (script.includes("package-consumers"))
    args.push("--tarball", artifact, "--out", path.join(scratch, "output"));
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited))
    if (key.toUpperCase() === "NODE_PATH") delete inherited[key];
  const result = spawnSync(process.execPath, args, {
    env: { ...inherited, Node_Path: "/untrusted/mixed", nOdE_pAtH: "/untrusted/duplicate" },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status).toBe(1); // Stop at the package-manager boundary, before installing/building.
  expect(JSON.parse(readFileSync(snapshot, "utf8")), result.stderr).toEqual([]);
});
