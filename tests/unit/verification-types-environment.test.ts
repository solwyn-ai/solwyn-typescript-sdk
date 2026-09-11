import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
type FixtureManifest = {
  private?: boolean;
  dependencies?: Record<string, string>;
};
type LockedPackage = {
  dependencies?: Record<string, string>;
  link?: boolean;
  resolved?: string;
};
type FixtureLock = {
  lockfileVersion?: number;
  packages: Record<string, LockedPackage>;
};

function successfulTypeChecks(kind: "native" | "ai") {
  const successfulCommand = () => ({ status: 0, stdout: "", stderr: "" });
  const compilerCells = [
    ["floor", "5.8.3", "esm"],
    ["floor", "5.8.3", "cjs"],
    ["current", "6.0.3", "esm"],
    ["current", "6.0.3", "cjs"],
  ].map(([label, version, format]) => ({
    compiler: { label, version },
    format,
    status: "pass",
    ...(kind === "native"
      ? { command: successfulCommand() }
      : {
          baseline: successfulCommand(),
          sdk: successfulCommand(),
          inference: successfulCommand(),
        }),
  }));
  return {
    strict: true,
    skipLibCheck: false,
    fixture: {
      manifestSha256: "a".repeat(64),
      lockSha256: "b".repeat(64),
      copiesPreserved: true,
    },
    isolation: {
      nodePathCleared: true,
      sdkResolvedInsideConsumer: true,
      installedPackagesAreReal: true,
    },
    dependencyTree: {
      lockedPackageCount: 1,
      preservedAfterSdkInstall: true,
    },
    cells: compilerCells,
    ...(kind === "ai"
      ? {
          upstreamBaselineDiagnostic: {
            compiler: { label: "diagnostic", version: "5.7.3" },
            format: "cjs",
            expected: "upstream-invalid",
            status: "upstream-invalid",
            command: { status: 2, stdout: "", stderr: "error TS1479: upstream is ESM" },
          },
        }
      : {}),
  };
}

async function createFakeNpm(directory: string, source: string) {
  const cli = join(directory, "npm-cli.js");
  await writeFile(cli, source);
  const executable = join(directory, process.platform === "win32" ? "npm.cmd" : "npm");
  if (process.platform === "win32") {
    await writeFile(executable, `@"${process.execPath}" "${cli}" %*\r\n`);
  } else {
    await writeFile(executable, `#!${process.execPath}\nrequire(${JSON.stringify(cli)});\n`);
    await chmod(executable, 0o755);
  }
  return cli;
}

function fakeNpmEnvironment(directory: string, cli: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== "NODE_PATH" && key.toUpperCase() !== "PATH",
    ),
  );
  env["PATH"] = `${directory}${delimiter}${process.env["PATH"] ?? ""}`;
  env["npm_execpath"] = cli;
  return env;
}

async function failedProbeReport(probe: string, directory: string, env: NodeJS.ProcessEnv) {
  const out = join(directory, "out");
  const script = join(root, "scripts/verification", `${probe}.mjs`);
  const args = [script, "--tarball", join(root, "package.json"), "--out", out];
  const failure = await execute(process.execPath, args, { cwd: root, env }).catch((error) => error);
  expect(failure).toMatchObject({ code: 1 });
  try {
    return JSON.parse(await readFile(join(out, `${probe}.json`), "utf8"));
  } catch (error) {
    throw new Error(`${failure.stderr ?? ""}\n${error}`);
  }
}

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s allocates beneath a parent-owned verification root", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-parent-"));
  const parentRoot = await mkdtemp(join(directory, "owned-"));
  try {
    const cli = await createFakeNpm(directory, "process.exitCode=1;\n");
    const env = fakeNpmEnvironment(directory, cli);
    env["SOLWYN_VERIFICATION_TEMP_ROOT"] = parentRoot;
    const report = await failedProbeReport(probe, directory, env);
    expect(dirname(report.details.consumerRoot)).toBe(await realpath(parentRoot));
    expect(report.cleanup.roots[0]).toMatchObject({
      path: report.details.consumerRoot,
      state: "removed",
      retained: false,
    });
    expect(existsSync(report.cleanup.roots[0].path)).toBe(false);
    expect(existsSync(parentRoot)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s removes its failed consumer but preserves output evidence", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-cleanup-"));
  try {
    const cli = await createFakeNpm(directory, "process.exitCode=1;\n");
    const report = await failedProbeReport(probe, directory, fakeNpmEnvironment(directory, cli));
    expect(report.cleanup.keepRequested).toBe(false);
    expect(report.cleanup.roots[0]).toMatchObject({ state: "removed", retained: false });
    expect(existsSync(report.cleanup.roots[0].path)).toBe(false);
    expect(existsSync(join(directory, "out", `${probe}.json`))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s reports and honors SMOKE_KEEP=1 after failure", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-keep-"));
  let consumerRoot = "";
  try {
    const cli = await createFakeNpm(directory, "process.exitCode=1;\n");
    const env = fakeNpmEnvironment(directory, cli);
    env["SMOKE_KEEP"] = "1";
    const report = await failedProbeReport(probe, directory, env);
    consumerRoot = report.details.consumerRoot;
    expect(report.cleanup.keepRequested).toBe(true);
    expect(report.cleanup.roots[0]).toMatchObject({
      path: consumerRoot,
      state: "retained",
      retained: true,
    });
    expect(existsSync(consumerRoot)).toBe(true);
  } finally {
    if (consumerRoot) await rm(consumerRoot, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
const fixtureGraphs = [
  {
    name: "native-types",
    dependencies: {
      "@anthropic-ai/sdk": "0.123.0",
      openai: "6.45.0",
      "typescript-current": "npm:typescript@6.0.3",
      "typescript-floor": "npm:typescript@5.8.3",
      zod: "4.4.3",
    },
  },
  {
    name: "ai-types",
    dependencies: {
      "@types/json-schema": "7.0.15",
      "@types/node": "22.15.30",
      ai: "7.0.14",
      "typescript-current": "npm:typescript@6.0.3",
      "typescript-diagnostic": "npm:typescript@5.7.3",
      "typescript-floor": "npm:typescript@5.8.3",
      zod: "4.4.3",
    },
  },
] as const;

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s rejects an output directory inside the repository", async (probe) => {
  const failure = await execute(
    process.execPath,
    [
      join(root, "scripts/verification", `${probe}.mjs`),
      "--tarball",
      join(root, "package.json"),
      "--out",
      root,
    ],
    { cwd: root },
  ).catch((error) => error);
  expect(failure).toMatchObject({ code: 1 });
  expect(failure.stderr).toContain("--out must be outside the repository");
});

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s finalizes a schema-v1 failure report and removes its registered root", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-schema-fail-"));
  try {
    const cli = await createFakeNpm(
      directory,
      `process.stderr.write("npm error code ERESOLVE\\n");process.exitCode=1;\n`,
    );
    const report = await failedProbeReport(probe, directory, fakeNpmEnvironment(directory, cli));
    expect(report).toMatchObject({
      schemaVersion: 1,
      probe,
      status: "fail",
      artifact: {
        path: await realpath(join(root, "package.json")),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      versions: { node: process.version },
      checks: {},
      details: {
        install: { status: 1 },
      },
      failure: {
        phase: "dependency-setup",
        kind: "command-failure",
        retryable: false,
        artifactFailure: false,
        errorCode: "ERESOLVE",
        step: "npm-ci",
      },
      cleanup: {
        keepRequested: false,
        roots: [
          {
            path: expect.any(String),
            state: "removed",
            retained: false,
          },
        ],
        failure: null,
      },
    });
    expect(existsSync(report.cleanup.roots[0].path)).toBe(false);
    expect(report.details).not.toHaveProperty("failure");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["native", "native-type-schema"],
  ["ai", "ai-type-schema"],
] as const)("finalizes a valid schema-v1 %s success report", async (kind, probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-schema-pass-"));
  const signalListeners = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  };
  try {
    const artifact = join(directory, "artifact.tgz");
    const file = join(directory, "report.json");
    await writeFile(artifact, "synthetic artifact identity");
    const support = pathToFileURL(join(root, "scripts/verification/support.mjs")).href;
    const typeSupport = pathToFileURL(
      join(root, "scripts/verification/type-consumer-support.mjs"),
    ).href;
    const program = `import {assertReport,createReport,createTemporaryRoot,finalizeReport} from ${JSON.stringify(support)};
import {assertTypeConsumerChecks} from ${JSON.stringify(typeSupport)};
const report=createReport({probe:${JSON.stringify(probe)},tarball:${JSON.stringify(artifact)},env:{SMOKE_KEEP:"0"}});
createTemporaryRoot("solwyn-type-schema-",report,{env:{SOLWYN_VERIFICATION_TEMP_ROOT:${JSON.stringify(directory)}}});
report.checks=${JSON.stringify(successfulTypeChecks(kind))};
assertTypeConsumerChecks(report,${JSON.stringify(kind)});
report.status="pass";
finalizeReport(report,${JSON.stringify(file)});
assertReport(report,{probe:${JSON.stringify(probe)}});
`;
    await execute(process.execPath, ["--input-type=module", "--eval", program], { cwd: root });
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      probe,
      status: "pass",
      failure: null,
      cleanup: {
        keepRequested: false,
        roots: [{ state: "removed", retained: false }],
        failure: null,
      },
    });
    expect(existsSync(persisted.cleanup.roots[0].path)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    expect(process.listeners("SIGINT")).toEqual(signalListeners.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(signalListeners.SIGTERM);
  }
});

it("does not let the expected TypeScript 5.7 upstream failure mask a required SDK failure", async () => {
  const typeSupport = await import(
    pathToFileURL(join(root, "scripts/verification/type-consumer-support.mjs")).href
  );
  const checks = successfulTypeChecks("ai");
  const firstCell = checks.cells[0];
  if (!firstCell || !("sdk" in firstCell)) throw new Error("Missing AI compiler cell");
  firstCell.sdk = { status: 2, stdout: "", stderr: "SDK declaration regression" };
  expect(() => typeSupport.assertTypeConsumerChecks({ checks }, "ai")).toThrow();
});

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s removes mixed-case NODE_PATH keys before spawning npm", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-env-"));
  try {
    const capture = await createFakeNpm(
      directory,
      `const leaked=Object.entries(process.env).filter(([key])=>key.toUpperCase()==="NODE_PATH");process.stdout.write(JSON.stringify(leaked));process.exitCode=1;\n`,
    );
    const env = fakeNpmEnvironment(directory, capture);
    env["Node_Path"] = join(directory, "must-not-reach-child");
    const out = join(directory, "out");
    await expect(
      execute(
        process.execPath,
        [
          join(root, "scripts/verification", `${probe}.mjs`),
          "--tarball",
          join(root, "package.json"),
          "--out",
          out,
        ],
        { cwd: root, env },
      ),
    ).rejects.toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(join(out, `${probe}.json`), "utf8"));
    expect(JSON.parse(report.details.install.stdout)).toEqual([]);
    expect(report.failure).toEqual({
      phase: "dependency-setup",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: null,
      step: "npm-ci",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["native-type-consumer", "native-types", "Locked native consumer npm ci failed"],
  ["ai-type-consumer", "ai-types", "Locked AI consumer npm ci failed"],
])("%s accepts an equivalent CRLF fixture checkout", async (probe, fixture, expectedFailure) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-crlf-"));
  try {
    const copiedRepository = join(directory, "repository");
    const verification = join(copiedRepository, "scripts/verification");
    const copiedFixture = join(verification, "fixtures", fixture);
    await mkdir(copiedFixture, { recursive: true });
    for (const name of [`${probe}.mjs`, "type-consumer-support.mjs", "support.mjs", "process.mjs"])
      await writeFile(
        join(verification, name),
        await readFile(join(root, "scripts/verification", name)),
      );
    for (const name of ["package.json", "package-lock.json"]) {
      const source = await readFile(
        join(root, "scripts/verification/fixtures", fixture, name),
        "utf8",
      );
      await writeFile(
        join(copiedFixture, name),
        source.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"),
      );
    }
    const shim = await createFakeNpm(directory, "process.exitCode=1;\n");
    const env = fakeNpmEnvironment(directory, shim);
    const out = join(directory, "out");
    await expect(
      execute(
        process.execPath,
        [join(verification, `${probe}.mjs`), "--tarball", join(root, "package.json"), "--out", out],
        { cwd: copiedRepository, env },
      ),
    ).rejects.toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(join(out, `${probe}.json`), "utf8"));
    expect(report.details.error).toContain(expectedFailure);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(
  ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ENETUNREACH", "ECONNREFUSED", "ERR_SOCKET_TIMEOUT"].map(
    (code, index) => [index % 2 === 0 ? "native-type-consumer" : "ai-type-consumer", code],
  ),
)("%s classifies npm ci %s as a retryable network failure", async (probe, code) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-network-"));
  try {
    const cli = await createFakeNpm(
      directory,
      `process.stderr.write("npm error code ${code}\\n");process.exitCode=1;\n`,
    );
    const report = await failedProbeReport(probe, directory, fakeNpmEnvironment(directory, cli));
    expect(report.failure).toEqual({
      phase: "dependency-setup",
      kind: "network",
      retryable: true,
      artifactFailure: false,
      errorCode: code,
      step: "npm-ci",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["native-type-consumer", "ENOTFOUND", "network", true],
  ["native-type-consumer", "ERESOLVE", "command-failure", false],
  ["ai-type-consumer", "ENOTFOUND", "network", true],
  ["ai-type-consumer", "ERESOLVE", "command-failure", false],
])("%s classifies SDK install %s evidence", async (probe, code, kind, retryable) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-sdk-install-"));
  try {
    const state = join(directory, "invocations");
    const cli = await createFakeNpm(
      directory,
      `const fs=require("node:fs");const path=require("node:path");const state=${JSON.stringify(state)};const count=fs.existsSync(state)?Number(fs.readFileSync(state,"utf8"))+1:1;fs.writeFileSync(state,String(count));if(count===1){const packageRoot=path.join(process.cwd(),"node_modules/sentinel");fs.mkdirSync(packageRoot,{recursive:true});fs.writeFileSync(path.join(packageRoot,"package.json"),JSON.stringify({name:"sentinel",version:"1.0.0"}));}else{process.stderr.write("npm error code ${code}\\n");process.exitCode=1;}\n`,
    );
    const report = await failedProbeReport(probe, directory, fakeNpmEnvironment(directory, cli));
    expect(report.failure).toEqual({
      phase: "dependency-setup",
      kind,
      retryable,
      artifactFailure: false,
      errorCode: code,
      step: "sdk-tarball-install",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("resolves the Windows npm JavaScript CLI through Node without a shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-windows-"));
  try {
    const cli = join(directory, "npm-cli.js");
    await writeFile(cli, "");
    const verifier = pathToFileURL(join(root, "scripts/verification/process.mjs")).href;
    const program = `import {resolvePackageManagerCommand} from ${JSON.stringify(verifier)};process.stdout.write(JSON.stringify(resolvePackageManagerCommand("npm",["ci","a & b","%USERPROFILE%",'quote"literal'],{platform:"win32",env:{npm_execpath:${JSON.stringify(cli)}},execPath:${JSON.stringify(process.execPath)}})));`;
    const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", program]);
    expect(JSON.parse(stdout)).toEqual({
      binary: process.execPath,
      args: [cli, "ci", "a & b", "%USERPROFILE%", 'quote"literal'],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports ENOENT when the Windows npm resolver has no real installation", async () => {
  const verifier = pathToFileURL(join(root, "scripts/verification/process.mjs")).href;
  const missingNode = "C:\\synthetic-missing-node\\node.exe";
  const program = `import {resolvePackageManagerCommand} from ${JSON.stringify(verifier)};try{resolvePackageManagerCommand("npm",["ci"],{platform:"win32",env:{PATH:""},execPath:${JSON.stringify(
    missingNode,
  )}})}catch(error){process.stdout.write(JSON.stringify({code:error.code,message:error.message}))}`;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", program]);
  expect(JSON.parse(stdout)).toMatchObject({
    code: "ENOENT",
    message: expect.stringContaining("Cannot locate the installed npm"),
  });
});

it.runIf(process.platform !== "win32")(
  "records a POSIX npm spawn error code in type-probe failure evidence",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-missing-npm-"));
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            key.toUpperCase() !== "NODE_PATH" &&
            key.toUpperCase() !== "PATH" &&
            key.toUpperCase() !== "NPM_EXECPATH",
        ),
      );
      env["PATH"] = "";
      const report = await failedProbeReport("native-type-consumer", directory, env);
      expect(report.details.install.error.code).toBe("ENOENT");
      expect(report.failure).toEqual({
        phase: "dependency-setup",
        kind: "command-failure",
        retryable: false,
        artifactFailure: false,
        errorCode: "ENOENT",
        step: "npm-ci",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("uses the shared retryable timeout classification", async () => {
  const verifier = pathToFileURL(join(root, "scripts/verification/process.mjs")).href;
  const program = `import {classifyCommandFailure} from ${JSON.stringify(verifier)};process.stdout.write(JSON.stringify(classifyCommandFailure("npm",{status:null,timedOut:true,error:{code:"ETIMEDOUT"},stderr:""})));`;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", program]);
  expect(JSON.parse(stdout)).toEqual({
    phase: "dependency-setup",
    kind: "timeout",
    retryable: true,
    artifactFailure: false,
    errorCode: "ETIMEDOUT",
  });
});

it("bounds a command whose descendant keeps inherited output pipes open", async () => {
  const verifier = pathToFileURL(join(root, "scripts/verification/process.mjs")).href;
  const descendant = "setTimeout(() => {}, 10_000)";
  const parent = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["--eval",${JSON.stringify(
    descendant,
  )}],{stdio:"inherit"});child.unref();setInterval(()=>{},10_000);`;
  const program = `import {runBoundedCommand} from ${JSON.stringify(verifier)};const result=await runBoundedCommand(process.execPath,["--eval",${JSON.stringify(
    parent,
  )}],{timeout:100});process.stdout.write(JSON.stringify({...result,error:result.error?{code:result.error.code,message:result.error.message}:undefined}));`;
  const started = Date.now();
  const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", program], {
    timeout: 3_000,
  });
  const result = JSON.parse(stdout);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result).toMatchObject({
    status: null,
    timedOut: true,
    timeoutMs: 100,
    error: { code: "ETIMEDOUT" },
  });
});

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s persists a bounded npm timeout while inherited pipes remain open", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-timeout-"));
  try {
    const preload = join(directory, "short-deadline.mjs");
    await writeFile(
      preload,
      `const original=globalThis.setTimeout;globalThis.setTimeout=(callback,ms,...args)=>original(callback,ms===180000?100:ms,...args);\n`,
    );
    const cli = await createFakeNpm(
      directory,
      `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["--eval","setInterval(()=>{},10_000)"],{stdio:"inherit"});child.unref();setInterval(()=>{},10_000);\n`,
    );
    const env = fakeNpmEnvironment(directory, cli);
    env["NODE_OPTIONS"] = `--import=${pathToFileURL(preload).href}`;
    const out = join(directory, "out");
    const started = Date.now();
    const failure = await execute(
      process.execPath,
      [
        join(root, "scripts/verification", `${probe}.mjs`),
        "--tarball",
        join(root, "package.json"),
        "--out",
        out,
      ],
      { cwd: root, env, timeout: 3_000 },
    ).catch((error) => error);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(failure).toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(join(out, `${probe}.json`), "utf8"));
    expect(report.details.install).toMatchObject({
      status: null,
      timedOut: true,
      timeoutMs: 180_000,
      error: { code: "ETIMEDOUT" },
    });
    expect(report.failure).toEqual({
      phase: "dependency-setup",
      kind: "timeout",
      retryable: true,
      artifactFailure: false,
      errorCode: "ETIMEDOUT",
      step: "npm-ci",
    });
    expect(existsSync(report.cleanup.roots[0].path)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s rejects a zero-exit npm root whose inherited pipes do not close", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-root-exit-"));
  try {
    const cli = await createFakeNpm(
      directory,
      `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["--eval","setTimeout(()=>{},1500)"],{stdio:"inherit"});child.unref();\n`,
    );
    const env = fakeNpmEnvironment(directory, cli);
    const out = join(directory, "out");
    const started = Date.now();
    const failure = await execute(
      process.execPath,
      [
        join(root, "scripts/verification", `${probe}.mjs`),
        "--tarball",
        join(root, "package.json"),
        "--out",
        out,
      ],
      { cwd: root, env, timeout: 3_000 },
    ).catch((error) => error);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(failure).toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(join(out, `${probe}.json`), "utf8"));
    expect(report.details.install).toMatchObject({
      status: 0,
      timedOut: true,
      pipeCleanupTimedOut: true,
      rootExit: { status: 0 },
      error: { code: "ERR_CHILD_PROCESS_PIPE_CLEANUP_TIMEOUT" },
    });
    expect(report.failure).toEqual({
      phase: "dependency-setup",
      kind: "timeout",
      retryable: true,
      artifactFailure: false,
      errorCode: "ERR_CHILD_PROCESS_PIPE_CLEANUP_TIMEOUT",
      step: "npm-ci",
    });
    expect(existsSync(report.cleanup.roots[0].path)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(
  fixtureGraphs,
)("$name has a complete registry-only lock for its exact graph", async (fixture) => {
  const directory = join(root, "scripts/verification/fixtures", fixture.name);
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as FixtureManifest;
  const lock = JSON.parse(
    await readFile(join(directory, "package-lock.json"), "utf8"),
  ) as FixtureLock;
  expect(manifest).toMatchObject({ private: true, dependencies: fixture.dependencies });
  expect(lock.lockfileVersion).toBe(3);
  expect(lock.packages[""]?.dependencies).toEqual(fixture.dependencies);
  expect(Object.values(lock.packages).some((entry) => entry.link === true)).toBe(false);
  expect(
    Object.values(lock.packages).every(
      (entry) =>
        entry.resolved === undefined || entry.resolved.startsWith("https://registry.npmjs.org/"),
    ),
  ).toBe(true);
});

it.each([
  "native-type-consumer",
  "ai-type-consumer",
])("%s rejects dependency-tree drift during the no-save tarball install", async (probe) => {
  const directory = await mkdtemp(join(tmpdir(), "solwyn-verification-types-tree-"));
  try {
    const state = join(directory, "invocations");
    const shim = await createFakeNpm(
      directory,
      `const fs=require("node:fs");const path=require("node:path");const state=${JSON.stringify(state)};const count=fs.existsSync(state)?Number(fs.readFileSync(state,"utf8"))+1:1;fs.writeFileSync(state,String(count));const packageRoot=path.join(process.cwd(),"node_modules/sentinel");fs.mkdirSync(packageRoot,{recursive:true});fs.writeFileSync(path.join(packageRoot,"package.json"),JSON.stringify({name:"sentinel",version:count===1?"1.0.0":"2.0.0"}));\n`,
    );
    const env = fakeNpmEnvironment(directory, shim);
    const out = join(directory, "out");
    await expect(
      execute(
        process.execPath,
        [
          join(root, "scripts/verification", `${probe}.mjs`),
          "--tarball",
          join(root, "package.json"),
          "--out",
          out,
        ],
        { cwd: root, env },
      ),
    ).rejects.toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(join(out, `${probe}.json`), "utf8"));
    expect(report.details.error).toContain("SDK tarball install changed locked dependency tree");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
