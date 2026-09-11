/** Shared locked-fixture setup for the native and AI declaration consumers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyCommandFailure, runBoundedCommand } from "./process.mjs";
import {
  createReport,
  createTemporaryRoot,
  failureFor,
  finalizeReport,
  parseArguments,
  verificationEnv,
  writeReport,
} from "./support.mjs";

export const strictCompilerOptions = {
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  noEmit: true,
  strict: true,
  skipLibCheck: false,
  lib: ["ES2023", "DOM", "ESNext.Disposable"],
};

export function commandSucceeded(result) {
  return !result.error && result.status === 0;
}

export function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizedTextSha256(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

function assertFixtureHash(file, expected) {
  assert.equal(normalizedTextSha256(file), expected, `Unexpected fixture content: ${file}`);
}

function assertSameBytes(source, copy) {
  assert.ok(fs.readFileSync(source).equals(fs.readFileSync(copy)), `Changed fixture copy: ${copy}`);
}

export function packageVersion(consumerRoot, packageName) {
  const packageRoot = path.join(consumerRoot, "node_modules", packageName);
  assert.equal(
    fs.lstatSync(packageRoot).isSymbolicLink(),
    false,
    `${packageName} must not be linked`,
  );
  const realConsumer = fs.realpathSync(consumerRoot);
  const relative = path.relative(realConsumer, fs.realpathSync(packageRoot));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

function installedDependencyTree(consumerRoot) {
  const realConsumer = fs.realpathSync(consumerRoot);
  const packages = [];
  const visitPackage = (packageRoot) => {
    assert.equal(fs.lstatSync(packageRoot).isSymbolicLink(), false);
    const realPackage = fs.realpathSync(packageRoot);
    const relativeToConsumer = path.relative(realConsumer, realPackage);
    assert.ok(
      relativeToConsumer &&
        !relativeToConsumer.startsWith("..") &&
        !path.isAbsolute(relativeToConsumer),
    );
    const manifest = path.join(packageRoot, "package.json");
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    packages.push({
      path: path.relative(consumerRoot, packageRoot).split(path.sep).join("/"),
      name: parsed.name,
      version: parsed.version,
      realpath: realPackage,
      manifestSha256: createHash("sha256").update(fs.readFileSync(manifest)).digest("hex"),
    });
    visitNodeModules(path.join(packageRoot, "node_modules"));
  };
  const visitNodeModules = (nodeModules) => {
    if (!fs.existsSync(nodeModules)) return;
    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      assert.equal(entry.isSymbolicLink(), false, `Linked dependency entry: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(nodeModules, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(entryPath, { withFileTypes: true })) {
          assert.equal(scoped.isSymbolicLink(), false, `Linked dependency entry: ${scoped.name}`);
          if (scoped.isDirectory()) visitPackage(path.join(entryPath, scoped.name));
        }
      } else {
        visitPackage(entryPath);
      }
    }
  };
  visitNodeModules(path.join(consumerRoot, "node_modules"));
  return packages.sort((left, right) => left.path.localeCompare(right.path));
}

function serializableCommand(binary, args, result) {
  const command = result.resolvedCommand ?? { binary, args };
  return {
    binary: command.binary,
    args: command.args,
    requestedBinary: binary,
    ...result,
    error: result.error
      ? { code: result.error.code ?? "UNKNOWN", message: result.error.message }
      : undefined,
  };
}

function setupFailure(result, step) {
  const failure = classifyCommandFailure("npm", result);
  assert.ok(failure, `Missing setup failure classification for ${step}`);
  return { ...failure, step };
}

export async function collectCompilerCells(context, compilerVersions, createCell) {
  const cells = [];
  for (const [label, version] of Object.entries(compilerVersions)) {
    const compilerPackage = `typescript-${label}`;
    assert.equal(packageVersion(context.consumerRoot, compilerPackage), version);
    for (const extension of ["mts", "cts"]) {
      const cell = await createCell({
        label,
        version,
        compilerPackage,
        extension,
        format: extension === "mts" ? "esm" : "cjs",
        tsc: path.join(context.consumerRoot, "node_modules", compilerPackage, "bin/tsc"),
      });
      cells.push(cell);
      context.persist();
    }
  }
  return cells;
}

export function assertTypeConsumerChecks(report, kind) {
  const checks = report.checks;
  assert.equal(checks.strict, true);
  assert.equal(checks.skipLibCheck, false);
  assert.equal(checks.fixture?.copiesPreserved, true);
  assert.match(checks.fixture?.manifestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(checks.fixture?.lockSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(checks.isolation?.nodePathCleared, true);
  assert.equal(checks.isolation?.sdkResolvedInsideConsumer, true);
  assert.equal(checks.isolation?.installedPackagesAreReal, true);
  assert.equal(checks.dependencyTree?.preservedAfterSdkInstall, true);
  assert.ok(checks.dependencyTree?.lockedPackageCount > 0);
  assert.equal(checks.cells?.length, 4);
  for (const label of ["floor", "current"])
    for (const format of ["esm", "cjs"]) {
      const cell = checks.cells.find(
        (candidate) => candidate.compiler?.label === label && candidate.format === format,
      );
      assert.ok(cell, `Missing ${label} ${format} compiler cell`);
      assert.equal(cell.status, "pass");
      if (kind === "native") assert.ok(commandSucceeded(cell.command));
      else {
        assert.ok(commandSucceeded(cell.baseline));
        assert.ok(commandSucceeded(cell.sdk));
        assert.ok(commandSucceeded(cell.inference));
      }
    }
  if (kind === "ai") {
    const diagnostic = checks.upstreamBaselineDiagnostic;
    assert.deepEqual(diagnostic?.compiler, { label: "diagnostic", version: "5.7.3" });
    assert.equal(diagnostic?.format, "cjs");
    assert.equal(diagnostic?.expected, "upstream-invalid");
    assert.equal(diagnostic?.status, "upstream-invalid");
    assert.ok(!diagnostic.command.error && diagnostic.command.status !== 0);
    assert.match(`${diagnostic.command.stdout}\n${diagnostic.command.stderr}`, /TS1479/);
  }
}

export async function runTypeConsumerProbe(config, verify) {
  const { tarball, out } = parseArguments(config.argv ?? process.argv.slice(2));
  const env = verificationEnv();
  const resultFile = path.join(out, `${config.probe}.json`);
  const report = createReport({
    probe: config.probe,
    tarball,
    env,
    versions: { typescript: config.compilerVersions, ...config.peerVersions },
  });
  const persist = () => writeReport(resultFile, report);
  report.details.commands = [];
  let consumerRoot;
  persist();

  const execute = async (label, binary, args, { cwd = consumerRoot, timeout = 300_000 } = {}) => {
    const running = { label, binary, args, cwd, state: "running", status: null };
    report.details.commands.push(running);
    persist();
    const result = await runBoundedCommand(binary, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
    const command = serializableCommand(binary, args, result);
    Object.assign(running, command, { state: "finished" });
    persist();
    return running;
  };

  try {
    consumerRoot = createTemporaryRoot(config.tempPrefix, report, { env });
    env.npm_config_cache = path.join(consumerRoot, ".npm-cache");
    report.details.consumerRoot = consumerRoot;
    persist();
    const fixtureManifest = path.join(config.dependencyFixture, "package.json");
    const fixtureLock = path.join(config.dependencyFixture, "package-lock.json");
    const consumerManifest = path.join(consumerRoot, "package.json");
    const consumerLock = path.join(consumerRoot, "package-lock.json");
    assertFixtureHash(fixtureManifest, config.fixtureHashes.manifest);
    assertFixtureHash(fixtureLock, config.fixtureHashes.lock);
    fs.copyFileSync(fixtureManifest, consumerManifest);
    fs.copyFileSync(fixtureLock, consumerLock);
    report.details.dependencyFixture = { directory: config.dependencyFixture };

    report.details.install = await execute(
      "npm-ci",
      "npm",
      ["ci", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"],
      { timeout: 180_000 },
    );
    if (!commandSucceeded(report.details.install)) {
      report.failure = setupFailure(report.details.install, "npm-ci");
      persist();
      throw Object.assign(new Error(config.installFailureMessage), {
        failure: report.failure,
      });
    }
    assertSameBytes(fixtureManifest, consumerManifest);
    assertSameBytes(fixtureLock, consumerLock);
    const lockedDependencyTree = installedDependencyTree(consumerRoot);
    report.details.lockedDependencyTree = lockedDependencyTree;

    report.details.sdkInstall = await execute(
      "sdk-tarball-install",
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--no-save",
        "--package-lock=false",
        tarball,
      ],
      { timeout: 180_000 },
    );
    if (!commandSucceeded(report.details.sdkInstall)) {
      report.failure = setupFailure(report.details.sdkInstall, "sdk-tarball-install");
      persist();
      throw Object.assign(new Error("SDK tarball install failed"), { failure: report.failure });
    }
    assertFixtureHash(fixtureManifest, config.fixtureHashes.manifest);
    assertFixtureHash(fixtureLock, config.fixtureHashes.lock);
    assertSameBytes(fixtureManifest, consumerManifest);
    assertSameBytes(fixtureLock, consumerLock);
    const dependencyTreeAfterSdkInstall = installedDependencyTree(consumerRoot).filter(
      (entry) => entry.path !== "node_modules/@solwyn/sdk",
    );
    assert.deepEqual(
      dependencyTreeAfterSdkInstall,
      lockedDependencyTree,
      "SDK tarball install changed locked dependency tree",
    );

    const resolutionCheck = path.join(consumerRoot, "resolve-sdk.mjs");
    fs.writeFileSync(
      resolutionCheck,
      `import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport {createRequire} from "node:module";\nimport path from "node:path";\nconst root=fs.realpathSync(process.argv[2]);\nconst req=createRequire(path.join(root,"package.json"));\nconst manifest=fs.realpathSync(req.resolve("@solwyn/sdk/package.json"));\nconst relative=path.relative(root,manifest);\nassert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));\nassert.equal(fs.lstatSync(path.join(root,"node_modules/@solwyn/sdk")).isSymbolicLink(),false);\nprocess.stdout.write(JSON.stringify({manifest}));\n`,
    );
    report.details.sdkResolution = await execute("sdk-resolution", process.execPath, [
      resolutionCheck,
      consumerRoot,
    ]);
    assert.ok(
      commandSucceeded(report.details.sdkResolution),
      "SDK did not resolve inside the consumer",
    );

    report.checks = {
      strict: true,
      skipLibCheck: false,
      fixture: {
        manifestSha256: config.fixtureHashes.manifest,
        lockSha256: config.fixtureHashes.lock,
        copiesPreserved: true,
      },
      isolation: {
        nodePathCleared: Object.keys(env).every((key) => key.toUpperCase() !== "NODE_PATH"),
        sdkResolvedInsideConsumer: true,
        installedPackagesAreReal: true,
      },
      dependencyTree: {
        lockedPackageCount: lockedDependencyTree.length,
        preservedAfterSdkInstall: true,
      },
      cells: [],
    };
    const context = { consumerRoot, report, resultFile, env, execute, persist };
    await verify(context);
    assertTypeConsumerChecks(report, config.kind);
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure ??= failureFor(error);
    report.details.error = error.stack ?? String(error);
  } finally {
    finalizeReport(report, resultFile);
  }
  return { report, resultFile };
}
