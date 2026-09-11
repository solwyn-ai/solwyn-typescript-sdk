import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/verification/browser-proof.mjs", import.meta.url),
);
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("browser artifact verification", () => {
  it.each([
    ["tarball", "Bundle must use this exact tarball"],
    ["bundle", "Browser must use the exact verified bundle"],
    ["browser", "No Chromium browser found"],
    ["version", "Browser version command failed"],
    ["websocket", "Browser driver requires a Node runtime"],
  ])("rejects an invalid %s instead of passing or skipping", (invalid, message) => {
    const out = mkdtempSync(path.join(tmpdir(), "task3-runtime-negative-"));
    temporary.push(out);
    const tarball = path.join(out, "artifact.tgz");
    const bundle = path.join(out, "edge-browser-bundle.js");
    writeFileSync(tarball, "synthetic artifact identity; no installation is reached");
    writeFileSync(bundle, "throw new Error('This bundle must not execute');");
    const hash = (filename: string) =>
      createHash("sha256").update(readFileSync(filename)).digest("hex");
    writeFileSync(
      path.join(out, "bundle-proofs.json"),
      JSON.stringify({
        schemaVersion: 1,
        probe: "bundle-proofs",
        status: "pass",
        artifact: {
          path: realpathSync(tarball),
          sha256: invalid === "tarball" ? "0".repeat(64) : hash(tarball),
        },
        versions: { node: process.version },
        checks: {
          bundleSha256: invalid === "bundle" ? "wrong" : hash(bundle),
        },
        details: {},
        failure: null,
        cleanup: { keepRequested: false, roots: [], failure: null },
      }),
    );
    const hooks = path.join(out, "prerequisite.mjs");
    writeFileSync(
      hooks,
      invalid === "version"
        ? "import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=(binary,args,options)=>spawn(binary,[...args.slice(0,-1),JSON.stringify({binary:process.execPath,args:['-e','process.exitCode=1']})],options);syncBuiltinESMExports();"
        : "globalThis.WebSocket=undefined;",
    );
    const result = spawnSync(
      process.execPath,
      ["--import", hooks, script, "--", "--tarball", tarball, "--out", out],
      {
        env: {
          ...process.env,
          SOLWYN_VERIFICATION_BROWSER:
            invalid === "browser" ? path.join(out, "absent-browser") : process.execPath,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(result.status).toBe(1);
    const report = JSON.parse(readFileSync(path.join(out, "browser-proof.json"), "utf8"));
    expect(report.probe).toBe("browser-proof");
    expect(report.status).toBe("fail");
    expect(report.details.error).toContain(message);
    expect(report.artifact.sha256).toBe(hash(tarball));
    expect(report.failure.artifactFailure).toBe(["tarball", "bundle"].includes(invalid));
    if (!["tarball", "bundle"].includes(invalid)) expect(report.failure.phase).toBe("environment");
  });
});

describe("runtime consumer environment isolation", () => {
  it.each([
    "NODE_PATH",
    "Node_Path",
    "node_path",
  ])("removes inherited %s before spawning consumers", (key) => {
    const out = mkdtempSync(path.join(tmpdir(), "task3-runtime-env-"));
    temporary.push(out);
    const helper = new URL("../../scripts/verification/runtime-support.mjs", import.meta.url).href;
    const child =
      "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(key => key.toUpperCase() === 'NODE_PATH')))";
    const program = `
      import { command } from ${JSON.stringify(helper)};
      const driver = Object.keys(process.env).filter(key => key.toUpperCase() === 'NODE_PATH');
      const consumer = JSON.parse(await command(process.execPath, ['-e', ${JSON.stringify(child)}], process.cwd()));
      process.stdout.write(JSON.stringify({driver, consumer}));
    `;
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toUpperCase() === "NODE_PATH") delete env[name];
    env[key] = out;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: out,
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ driver: [], consumer: [] });
  });
});

it("classifies a missing configured Node executable before installing consumers", () => {
  const out = mkdtempSync(path.join(tmpdir(), "task3-node-prerequisite-"));
  temporary.push(out);
  const tarball = path.join(out, "artifact.tgz");
  writeFileSync(tarball, "prerequisite validation must happen before installation");
  const runtime = fileURLToPath(
    new URL("../../scripts/verification/runtime-matrix.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [runtime, "--tarball", tarball, "--out", out], {
    env: {
      ...process.env,
      SOLWYN_VERIFICATION_NODE_BINARIES: JSON.stringify([path.join(out, "absent-node")]),
    },
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(readFileSync(path.join(out, "runtime-matrix.json"), "utf8"));
  expect(report.failure).toMatchObject({
    phase: "environment",
    kind: "prerequisite",
    artifactFailure: false,
  });
  expect(report.cleanup.roots).toEqual([]);
});
