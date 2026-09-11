#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePublishableVersion } from "./release-policy.mjs";
import { resolvePackageManagerCommand } from "./verification/process.mjs";

const PACKAGE_NAME = "@solwyn/sdk";
const RECEIPT_FILENAME = "release-artifact-receipt.json";
const SAFE_SOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/;
const IMMUTABLE_COMMIT = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(message);
}

function isPublishableVersion(value) {
  try {
    validatePublishableVersion(value);
    return true;
  } catch {
    return false;
  }
}

function parseCreateArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--out" && flag !== "--ref") || !value) fail("Invalid create arguments");
    const key = flag.slice(2);
    if (options[key]) fail(`Duplicate ${flag}`);
    options[key] = value;
  }
  if (!options.out || !path.isAbsolute(options.out)) fail("--out requires an absolute path");
  return options;
}

function parseVerifyArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--tarball", "--receipt", "--ref", "--version"].includes(flag) || !value)
      fail("Invalid verify arguments");
    const key = flag.slice(2);
    if (options[key]) fail(`Duplicate ${flag}`);
    if ((flag === "--tarball" || flag === "--receipt") && !path.isAbsolute(value))
      fail(`${flag} requires an absolute path`);
    options[key] = value;
  }
  if (!options.tarball || !options.receipt) fail("--tarball and --receipt are required");
  return options;
}

function parseVerifyDirectoryArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--dir", "--ref", "--version", "--github-env"].includes(flag) || !value)
      fail("Invalid verify-directory arguments");
    const key = flag === "--github-env" ? "githubEnv" : flag.slice(2);
    if (options[key]) fail(`Duplicate ${flag}`);
    if ((flag === "--dir" || flag === "--github-env") && !path.isAbsolute(value))
      fail(`${flag} requires an absolute path`);
    options[key] = value;
  }
  if (!options.dir || !options.ref || !options.version || !options.githubEnv)
    fail("--dir, --ref, --version, and --github-env are required");
  if (!IMMUTABLE_COMMIT.test(options.ref)) fail("--ref must be an immutable commit");
  if (!isPublishableVersion(options.version)) fail("--version must be a publishable SemVer");
  return options;
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function readManifest(cwd) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (!isObject(manifest)) fail("invalid manifest");
    return manifest;
  } catch {
    fail("package.json must be valid JSON");
  }
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) fail("Checkout must be a Git repository");
  return result.stdout.trim();
}

function resolveSourceRef(sourceRef, cwd) {
  if (!SAFE_SOURCE_REF.test(sourceRef)) fail("Source ref is invalid");
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`],
    { cwd, encoding: "utf8" },
  );
  if (result.error || result.status !== 0) fail("Source ref must resolve to checkout HEAD");
  return result.stdout.trim();
}

function prospectiveRealpath(destination) {
  let existing = destination;
  const suffix = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) fail("Path has no existing ancestor");
      suffix.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected
      .slice()
      .sort()
      .every((key, index) => key === actual[index])
  );
}

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafePackagePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (value.includes("\\") || hasControlCharacter(value) || path.posix.isAbsolute(value))
    return false;
  if (path.posix.normalize(value) !== value) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function assertReceipt(receipt, message = "Receipt is malformed") {
  const malformed = () => fail(message);
  if (!hasExactKeys(receipt, ["schemaVersion", "package", "source", "artifact", "files"]))
    malformed();
  if (receipt.schemaVersion !== 1) malformed();
  if (!hasExactKeys(receipt.package, ["name", "version"])) malformed();
  if (receipt.package.name !== PACKAGE_NAME || !isPublishableVersion(receipt.package.version))
    malformed();
  if (!hasExactKeys(receipt.source, ["commit"]) || !IMMUTABLE_COMMIT.test(receipt.source.commit))
    malformed();
  if (!hasExactKeys(receipt.artifact, ["filename", "size", "sha256", "integrity", "shasum"]))
    malformed();
  const expectedFilename = `solwyn-sdk-${receipt.package.version}.tgz`;
  if (
    receipt.artifact.filename !== expectedFilename ||
    !Number.isSafeInteger(receipt.artifact.size) ||
    receipt.artifact.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.artifact.sha256) ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(receipt.artifact.integrity) ||
    !/^[a-f0-9]{40}$/.test(receipt.artifact.shasum)
  )
    malformed();
  if (!Array.isArray(receipt.files) || receipt.files.length === 0) malformed();
  let previous;
  for (const file of receipt.files) {
    if (
      !hasExactKeys(file, ["path", "mode", "size"]) ||
      !isSafePackagePath(file.path) ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (previous !== undefined && previous >= file.path)
    )
      malformed();
    previous = file.path;
  }
  if (!receipt.files.some((file) => file.path === "package.json")) malformed();
  return receipt;
}

function regularRealpath(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

function assertDirectoryEntries(directory, expected, message) {
  const actual = fs.readdirSync(directory).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    !actual.every((entry, index) => entry === required[index])
  )
    fail(message);
}

function removePackOutputs(out) {
  for (const entry of fs.readdirSync(out)) {
    if (!entry.endsWith(".tgz")) continue;
    const candidate = path.join(out, entry);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) fs.rmSync(candidate);
    } catch {
      // Preserve the primary pack validation failure.
    }
  }
}

function isBuiltDirectory(root) {
  const pending = [root];
  let fileCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
      else if (entry.isFile()) fileCount += 1;
      else return false;
    }
  }
  return fileCount > 0;
}

function create(args, cwd = process.cwd()) {
  const options = parseCreateArguments(args);
  const manifest = readManifest(cwd);
  if (manifest.name !== PACKAGE_NAME) fail(`Package name must be ${PACKAGE_NAME}`);
  if (!isPublishableVersion(manifest.version)) fail("Package version must be a publishable SemVer");
  if (git(["status", "--porcelain=v1", "--untracked-files=all"], cwd))
    fail("Checkout must be clean before packing");
  const head = git(["rev-parse", "HEAD"], cwd);
  const sourceRef = options.ref ?? head;
  const sourceCommit = resolveSourceRef(sourceRef, cwd);
  if (sourceCommit !== head) fail("Source ref must resolve to checkout HEAD");
  try {
    const distPath = path.join(cwd, "dist");
    const dist = fs.lstatSync(distPath);
    if (!dist.isDirectory() || dist.isSymbolicLink() || !isBuiltDirectory(distPath))
      fail("invalid dist");
  } catch {
    fail("dist must be an already-built directory");
  }

  const checkout = fs.realpathSync(cwd);
  const requestedOut = prospectiveRealpath(options.out);
  if (isWithin(checkout, requestedOut)) fail("--out must resolve outside the checkout");
  fs.mkdirSync(options.out, { recursive: true });
  const out = fs.realpathSync(options.out);
  assertDirectoryEntries(out, [], "Artifact directory must be empty");
  const packArguments = ["pack", "--ignore-scripts", "--json", "--pack-destination", out];
  let pack;
  try {
    const command = resolvePackageManagerCommand("npm", packArguments);
    pack = spawnSync(command.binary, command.args, { cwd, encoding: "utf8" });
  } catch {
    removePackOutputs(out);
    fail("npm pack failed");
  }
  if (pack.error || pack.status !== 0) {
    removePackOutputs(out);
    fail("npm pack failed");
  }
  const expectedFilename = `solwyn-sdk-${manifest.version}.tgz`;
  let filename;
  let receipt;
  try {
    const packed = JSON.parse(pack.stdout);
    if (!Array.isArray(packed) || packed.length !== 1) fail("npm pack must return one result");
    const [result] = packed;
    if (!isObject(result) || typeof result.filename !== "string")
      fail("npm pack returned malformed metadata");
    filename = result.filename;
    if (filename !== expectedFilename) fail("npm pack returned an unexpected filename");
    assertDirectoryEntries(out, [filename], "npm pack returned malformed metadata");
    const artifact = regularRealpath(path.join(out, filename));
    if (!artifact || path.dirname(artifact) !== out) fail("npm pack returned malformed metadata");
    const bytes = fs.readFileSync(artifact);
    const sha256 = digest("sha256", bytes, "hex");
    const integrity = `sha512-${digest("sha512", bytes, "base64")}`;
    const shasum = digest("sha1", bytes, "hex");
    if (
      result.name !== manifest.name ||
      result.version !== manifest.version ||
      result.size !== bytes.length ||
      result.integrity !== integrity ||
      result.shasum !== shasum ||
      !Array.isArray(result.files)
    )
      fail("npm pack returned malformed metadata");
    receipt = {
      schemaVersion: 1,
      package: { name: manifest.name, version: manifest.version },
      source: { commit: sourceCommit },
      artifact: { filename, size: bytes.length, sha256, integrity, shasum },
      files: result.files
        .map(({ path: file, mode, size }) => ({ path: file, mode, size }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    };
    assertReceipt(receipt, "npm pack returned malformed metadata");
  } catch (error) {
    removePackOutputs(out);
    if (
      error.message === "npm pack must return one result" ||
      error.message === "npm pack returned an unexpected filename" ||
      error.message === "npm pack returned malformed metadata"
    )
      throw error;
    fail("npm pack returned malformed metadata");
  }
  try {
    fs.writeFileSync(path.join(out, RECEIPT_FILENAME), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    removePackOutputs(out);
    if (error.code === "EEXIST") fail("Receipt already exists");
    fail("Could not write receipt");
  }
  process.stdout.write(`created ${filename} and ${RECEIPT_FILENAME}\n`);
}

function verifyFiles(options) {
  const tarball = regularRealpath(options.tarball);
  const receiptFile = regularRealpath(options.receipt);
  if (
    !tarball ||
    !receiptFile ||
    path.dirname(tarball) !== path.dirname(receiptFile) ||
    path.basename(receiptFile) !== RECEIPT_FILENAME
  )
    fail("Tarball and receipt must be regular sibling files");
  let receipt;
  try {
    receipt = assertReceipt(JSON.parse(fs.readFileSync(receiptFile, "utf8")));
  } catch (error) {
    if (error.message === "Receipt is malformed") throw error;
    fail("Receipt is malformed");
  }
  if (options.ref !== undefined && options.ref !== receipt.source.commit)
    fail("Receipt source ref mismatch");
  if (options.version !== undefined && options.version !== receipt.package.version)
    fail("Receipt package version mismatch");
  if (path.basename(tarball) !== receipt.artifact.filename) fail("Tarball filename mismatch");
  const bytes = fs.readFileSync(tarball);
  if (bytes.length !== receipt.artifact.size) fail("Tarball size mismatch");
  if (digest("sha256", bytes, "hex") !== receipt.artifact.sha256) fail("Tarball SHA-256 mismatch");
  if (`sha512-${digest("sha512", bytes, "base64")}` !== receipt.artifact.integrity)
    fail("Tarball integrity mismatch");
  if (digest("sha1", bytes, "hex") !== receipt.artifact.shasum) fail("Tarball shasum mismatch");
  return { receipt, receiptFile, tarball };
}

function writeVerifiedPaths(githubEnv, tarball, receiptFile) {
  if (hasControlCharacter(tarball) || hasControlCharacter(receiptFile))
    fail("Artifact directory path is unsafe");
  let stat;
  try {
    stat = fs.lstatSync(githubEnv);
  } catch (error) {
    if (error.code !== "ENOENT") fail("--github-env must be a regular file");
  }
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    fail("--github-env must be a regular file");
  try {
    fs.appendFileSync(githubEnv, `TARBALL=${tarball}\nRECEIPT=${receiptFile}\n`, "utf8");
  } catch {
    fail("Could not write GitHub environment file");
  }
}

function printVerified(tarball, receiptFile) {
  process.stdout.write(
    `verified ${path.basename(tarball)} against ${path.basename(receiptFile)}\n`,
  );
}

function verify(args) {
  const { tarball, receiptFile } = verifyFiles(parseVerifyArguments(args));
  printVerified(tarball, receiptFile);
}

function verifyDirectory(args) {
  const options = parseVerifyDirectoryArguments(args);
  let directory;
  try {
    const stat = fs.lstatSync(options.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid directory");
    directory = fs.realpathSync(options.dir);
  } catch {
    fail("--dir must be a regular directory");
  }
  const expectedTarball = `solwyn-sdk-${options.version}.tgz`;
  assertDirectoryEntries(
    directory,
    [expectedTarball, RECEIPT_FILENAME],
    "Artifact directory must contain exactly one tarball and one receipt",
  );
  const { tarball, receiptFile } = verifyFiles({
    tarball: path.join(directory, expectedTarball),
    receipt: path.join(directory, RECEIPT_FILENAME),
    ref: options.ref,
    version: options.version,
  });
  writeVerifiedPaths(options.githubEnv, tarball, receiptFile);
  printVerified(tarball, receiptFile);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") create(args);
  else if (command === "verify") verify(args);
  else if (command === "verify-directory") verifyDirectory(args);
  else fail("Expected create, verify, or verify-directory command");
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[release-artifact] ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}
