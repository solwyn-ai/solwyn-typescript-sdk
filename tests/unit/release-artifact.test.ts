import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../scripts/release-artifact.mjs", import.meta.url));
const releasePolicy = new URL("../../scripts/release-policy.mjs", import.meta.url).href;
const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function fixture(version = "1.2.3-rc.1") {
  const scratch = mkdtempSync(path.join(tmpdir(), "release-artifact-test-"));
  temporary.push(scratch);
  const repository = path.join(scratch, "repository");
  const out = path.join(scratch, "artifacts");
  mkdirSync(path.join(repository, "dist"), { recursive: true });
  mkdirSync(out);
  writeFileSync(
    path.join(repository, "package.json"),
    `${JSON.stringify({ name: "@solwyn/sdk", version, files: ["dist"] }, null, 2)}\n`,
  );
  writeFileSync(path.join(repository, "dist/index.js"), "export const answer = 42;\n");
  run("git", ["init", "--quiet"], repository);
  run("git", ["add", "."], repository);
  run(
    "git",
    [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    repository,
  );
  const ref = run("git", ["rev-parse", "HEAD"], repository);
  return { out, ref, repository, scratch };
}

function createArtifact(repository: string, out: string, ref: string) {
  return spawnSync(process.execPath, [cli, "create", "--out", out, "--ref", ref], {
    cwd: repository,
    encoding: "utf8",
  });
}

function verifyArtifact(repository: string, out: string, extraArguments: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "verify",
      "--tarball",
      path.join(out, "solwyn-sdk-1.2.3-rc.1.tgz"),
      "--receipt",
      path.join(out, "release-artifact-receipt.json"),
      ...extraArguments,
    ],
    { cwd: repository, encoding: "utf8", env: { ...process.env, PATH: "" } },
  );
}

function verifyDirectory(
  repository: string,
  directory: string,
  ref: string,
  version: string,
  githubEnv: string,
) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "verify-directory",
      "--dir",
      directory,
      "--ref",
      ref,
      "--version",
      version,
      "--github-env",
      githubEnv,
    ],
    { cwd: repository, encoding: "utf8", env: { ...process.env, PATH: "" } },
  );
}

type TestReceipt = {
  schemaVersion: number;
  package: { name: string; version: string };
  source: { commit: string };
  artifact: {
    filename: string;
    size: number;
    sha256: string;
    integrity: string;
    shasum: string;
  };
  files: Array<{ path: string; mode: number; size: number }>;
};

function firstReceiptFile(receipt: TestReceipt): TestReceipt["files"][number] {
  const file = receipt.files[0];
  if (file === undefined) throw new Error("fixture receipt has no files");
  return file;
}

function installFakeNpm(scratch: string, source: string) {
  const fakeBin = path.join(scratch, "fake-bin");
  mkdirSync(fakeBin);
  const fakeNpm = path.join(fakeBin, "npm");
  writeFileSync(fakeNpm, `#!/usr/bin/env node\n${source}`);
  chmodSync(fakeNpm, 0o755);
  return fakeBin;
}

function fakePackSource(mutation: string) {
  return `
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const out=process.argv[process.argv.indexOf("--pack-destination")+1];
const filename="solwyn-sdk-1.2.3-rc.1.tgz";
const bytes=Buffer.from("fake pack bytes");
fs.writeFileSync(path.join(out,filename),bytes);
const result={name:"@solwyn/sdk",version:"1.2.3-rc.1",filename,size:bytes.length,shasum:createHash("sha1").update(bytes).digest("hex"),integrity:"sha512-"+createHash("sha512").update(bytes).digest("base64"),files:[{path:"dist/index.js",size:26,mode:420},{path:"package.json",size:84,mode:420}]};
let output=[result];
${mutation}
process.stdout.write(JSON.stringify(output));
`;
}

it("creates one named tarball and a deterministic schema-v1 receipt", () => {
  const { out, ref, repository } = fixture();
  const child = createArtifact(repository, out, ref);

  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe(
    "created solwyn-sdk-1.2.3-rc.1.tgz and release-artifact-receipt.json\n",
  );
  const receiptFile = path.join(out, "release-artifact-receipt.json");
  const receiptText = readFileSync(receiptFile, "utf8");
  expect(receiptText.endsWith("\n")).toBe(true);
  const receipt = JSON.parse(receiptText);
  expect(receipt).toMatchObject({
    schemaVersion: 1,
    package: { name: "@solwyn/sdk", version: "1.2.3-rc.1" },
    source: { commit: ref },
    artifact: {
      filename: "solwyn-sdk-1.2.3-rc.1.tgz",
      size: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]{86}==$/),
      shasum: expect.stringMatching(/^[a-f0-9]{40}$/),
    },
  });
  expect(receipt.files).toEqual([
    { path: "dist/index.js", mode: 420, size: 26 },
    { path: "package.json", mode: 420, size: 84 },
  ]);
});

it("verifies the downloaded tarball bytes against the receipt without repacking", () => {
  const { out, ref, repository } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);

  const tarball = path.join(out, "solwyn-sdk-1.2.3-rc.1.tgz");
  const receipt = path.join(out, "release-artifact-receipt.json");
  const verified = spawnSync(
    process.execPath,
    [
      cli,
      "verify",
      "--tarball",
      tarball,
      "--receipt",
      receipt,
      "--ref",
      ref,
      "--version",
      "1.2.3-rc.1",
    ],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    },
  );

  expect(verified.status, verified.stderr).toBe(0);
  expect(verified.stdout).toBe(
    "verified solwyn-sdk-1.2.3-rc.1.tgz against release-artifact-receipt.json\n",
  );
});

it("creates an artifact for a stable release SemVer accepted by the common policy", async () => {
  const { out, ref, repository } = fixture("1.2.3");
  const policy = (await import(releasePolicy)) as {
    validatePublishableVersion(value: string): unknown;
  };

  const child = createArtifact(repository, out, ref);

  expect(() => policy.validatePublishableVersion("1.2.3")).not.toThrow();
  expect(child.status, child.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(path.join(out, "release-artifact-receipt.json"), "utf8"));
  expect(receipt.package.version).toBe("1.2.3");
  expect(receipt.artifact.filename).toBe("solwyn-sdk-1.2.3.tgz");
});

it.each([
  "0.0.0",
  "1.2.3-01",
  "01.2.3-rc.1",
  "1.2.3-",
  "1.2.3-rc.1+build.1",
])("rejects a manifest version rejected by the common policy: %s", async (version) => {
  const { out, ref, repository } = fixture(version);
  const policy = (await import(releasePolicy)) as {
    validatePublishableVersion(value: string): unknown;
  };
  const child = createArtifact(repository, out, ref);

  expect(() => policy.validatePublishableVersion(version)).toThrow();
  expect(child.status).toBe(1);
  expect(child.stderr).toBe(
    "[release-artifact] ERROR Package version must be a publishable SemVer\n",
  );
});

it("refuses to pack a dirty checkout", () => {
  const { out, ref, repository } = fixture();
  writeFileSync(path.join(repository, "dist/index.js"), "changed after commit\n");

  const child = createArtifact(repository, out, ref);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR Checkout must be clean before packing\n");
  expect(readFileSync(path.join(repository, "dist/index.js"), "utf8")).toBe(
    "changed after commit\n",
  );
});

it("refuses to pack when the checkout has no built dist artifact", () => {
  const { out, repository } = fixture();
  rmSync(path.join(repository, "dist"), { recursive: true });
  run("git", ["add", "--all"], repository);
  run(
    "git",
    [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "remove dist",
    ],
    repository,
  );
  const cleanRef = run("git", ["rev-parse", "HEAD"], repository);

  const child = createArtifact(repository, out, cleanRef);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR dist must be an already-built directory\n");
});

it("refuses to pack an empty built dist directory", () => {
  const { out, repository } = fixture();
  rmSync(path.join(repository, "dist"), { recursive: true });
  run("git", ["add", "--all"], repository);
  run(
    "git",
    [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "remove built files",
    ],
    repository,
  );
  mkdirSync(path.join(repository, "dist"));
  const cleanRef = run("git", ["rev-parse", "HEAD"], repository);

  const child = createArtifact(repository, out, cleanRef);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR dist must be an already-built directory\n");
});

it("resolves the checkout commit when create omits --ref", () => {
  const { out, ref, repository } = fixture();

  const child = spawnSync(process.execPath, [cli, "create", "--out", out], {
    cwd: repository,
    encoding: "utf8",
  });

  expect(child.status, child.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(path.join(out, "release-artifact-receipt.json"), "utf8"));
  expect(receipt.source).toEqual({ commit: ref });
});

it("rejects a supplied source ref that does not resolve to checkout HEAD", () => {
  const { out, repository } = fixture();

  const child = createArtifact(repository, out, "0000000000000000000000000000000000000000");

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR Source ref must resolve to checkout HEAD\n");
});

it("rejects an unsafe source ref without echoing it", () => {
  const { out, repository } = fixture();
  const unsafe = "refs/tags/release\nsecret-value";

  const child = createArtifact(repository, out, unsafe);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR Source ref is invalid\n");
  expect(child.stderr).not.toContain("secret-value");
});

it("rejects malformed package JSON without leaking its contents", () => {
  const { out, repository } = fixture();
  writeFileSync(path.join(repository, "package.json"), '{"unexpected":"secret-value"');
  run("git", ["add", "package.json"], repository);
  run(
    "git",
    [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "malformed manifest",
    ],
    repository,
  );
  const ref = run("git", ["rev-parse", "HEAD"], repository);

  const child = createArtifact(repository, out, ref);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR package.json must be valid JSON\n");
  expect(child.stderr).not.toContain("secret-value");
});

it("requires the artifact directory to be outside the checkout", () => {
  const { ref, repository } = fixture();
  const unsafeOut = path.join(repository, "artifacts");

  const child = createArtifact(repository, unsafeOut, ref);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR --out must resolve outside the checkout\n");
});

it("does not overwrite a preexisting or stale tarball", () => {
  const { out, ref, repository } = fixture();
  const existing = path.join(out, "solwyn-sdk-1.2.3-rc.1.tgz");
  writeFileSync(existing, "preexisting artifact bytes");

  const child = createArtifact(repository, out, ref);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR Artifact directory must be empty\n");
  expect(readFileSync(existing, "utf8")).toBe("preexisting artifact bytes");
});

it("does not pack or overwrite when the receipt already exists", () => {
  const { out, ref, repository } = fixture();
  const receipt = path.join(out, "release-artifact-receipt.json");
  writeFileSync(receipt, "preexisting receipt\n");

  const child = createArtifact(repository, out, ref);

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR Artifact directory must be empty\n");
  expect(readFileSync(receipt, "utf8")).toBe("preexisting receipt\n");
  expect(readdirSync(out).filter((entry) => entry.endsWith(".tgz"))).toEqual([]);
});

it("rejects an unrelated output entry before invoking npm", () => {
  const { out, ref, repository, scratch } = fixture();
  const existing = path.join(out, "keep.txt");
  const invoked = path.join(scratch, "npm-invoked");
  writeFileSync(existing, "keep these bytes\n");
  const fakeBin = installFakeNpm(
    scratch,
    `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(invoked)},"invoked");process.exitCode=1;`,
  );

  const child = spawnSync(process.execPath, [cli, "create", "--out", out, "--ref", ref], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"]}` },
  });

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR Artifact directory must be empty\n");
  expect(readFileSync(existing, "utf8")).toBe("keep these bytes\n");
  expect(existsSync(invoked)).toBe(false);
});

it("fails closed when npm pack returns an unsafe file inventory", () => {
  const { out, ref, repository, scratch } = fixture();
  const fakeBin = installFakeNpm(
    scratch,
    `
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const out=process.argv[process.argv.indexOf("--pack-destination")+1];
const filename="solwyn-sdk-1.2.3-rc.1.tgz";
const bytes=Buffer.from("fake pack bytes");
fs.writeFileSync(path.join(out,filename),bytes);
const result={name:"@solwyn/sdk",version:"1.2.3-rc.1",filename,size:bytes.length,shasum:createHash("sha1").update(bytes).digest("hex"),integrity:"sha512-"+createHash("sha512").update(bytes).digest("base64"),files:[{path:"../escape",size:1,mode:420}]};
process.stdout.write(JSON.stringify([result]));
`,
  );

  const child = spawnSync(process.execPath, [cli, "create", "--out", out, "--ref", ref], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"]}` },
  });

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR npm pack returned malformed metadata\n");
  expect(readdirSync(out)).toEqual([]);
});

it.each([
  ["multiple results", "output=[result,{...result}]", "npm pack must return one result"],
  [
    "unexpected filename",
    'result.filename="renamed-sdk.tgz"',
    "npm pack returned an unexpected filename",
  ],
  [
    "an extra tarball",
    'fs.writeFileSync(path.join(out,"extra.tgz"),"extra")',
    "npm pack returned malformed metadata",
  ],
  ["the wrong package", 'result.name="@other/sdk"', "npm pack returned malformed metadata"],
  ["the wrong version", 'result.version="1.2.4"', "npm pack returned malformed metadata"],
  ["the wrong size", "result.size+=1", "npm pack returned malformed metadata"],
  [
    "the wrong integrity",
    'result.integrity="sha512-"+"A".repeat(88)',
    "npm pack returned malformed metadata",
  ],
  ["the wrong shasum", 'result.shasum="0".repeat(40)', "npm pack returned malformed metadata"],
  ["a non-array file inventory", "result.files={}", "npm pack returned malformed metadata"],
] as const)("removes every tarball when npm pack returns %s", (_name, mutation, message) => {
  const { out, ref, repository, scratch } = fixture();
  const fakeBin = installFakeNpm(scratch, fakePackSource(mutation));

  const child = spawnSync(process.execPath, [cli, "create", "--out", out, "--ref", ref], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"]}` },
  });

  expect(child.status).toBe(1);
  expect(child.stderr).toBe(`[release-artifact] ERROR ${message}\n`);
  expect(readdirSync(out)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "uses the shared Windows-safe npm launcher without a command shell",
  () => {
    const { out, ref, repository, scratch } = fixture();
    const npmCli = path.join(scratch, "npm-cli.js");
    writeFileSync(npmCli, fakePackSource(""));
    const commandPath = path.join(scratch, "windows-command-path");
    mkdirSync(commandPath);
    symlinkSync(run("which", ["git"], repository), path.join(commandPath, "git"));
    const program = `
Object.defineProperty(process,"platform",{value:"win32"});
process.argv=[process.execPath,${JSON.stringify(cli)},"create","--out",${JSON.stringify(out)},"--ref",${JSON.stringify(ref)}];
await import(${JSON.stringify(pathToFileURL(cli).href)});
`;

    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, PATH: commandPath, npm_execpath: npmCli },
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(
      "created solwyn-sdk-1.2.3-rc.1.tgz and release-artifact-receipt.json\n",
    );
  },
);

it("removes partial tarballs when npm pack fails", () => {
  const { out, ref, repository, scratch } = fixture();
  const fakeBin = installFakeNpm(
    scratch,
    `
import fs from "node:fs";
import path from "node:path";
const out=process.argv[process.argv.indexOf("--pack-destination")+1];
fs.writeFileSync(path.join(out,"partial.tgz"),"partial artifact");
process.exitCode=1;
`,
  );

  const child = spawnSync(process.execPath, [cli, "create", "--out", out, "--ref", ref], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env["PATH"]}` },
  });

  expect(child.status).toBe(1);
  expect(child.stderr).toBe("[release-artifact] ERROR npm pack failed\n");
  expect(readdirSync(out)).toEqual([]);
});

it.each([
  ["--ref", "0000000000000000000000000000000000000000", "Receipt source ref mismatch"],
  ["--version", "1.2.3-rc.2", "Receipt package version mismatch"],
])("verify rejects an unexpected receipt value for %s", (flag, value, message) => {
  const { out, ref, repository } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);

  const verified = spawnSync(
    process.execPath,
    [
      cli,
      "verify",
      "--tarball",
      path.join(out, "solwyn-sdk-1.2.3-rc.1.tgz"),
      "--receipt",
      path.join(out, "release-artifact-receipt.json"),
      flag,
      value,
    ],
    { cwd: repository, encoding: "utf8", env: { ...process.env, PATH: "" } },
  );

  expect(verified.status).toBe(1);
  expect(verified.stderr).toBe(`[release-artifact] ERROR ${message}\n`);
});

const malformedReceiptMutations: ReadonlyArray<readonly [string, (receipt: TestReceipt) => void]> =
  [
    [
      "missing schema",
      (receipt) => {
        Reflect.deleteProperty(receipt, "schemaVersion");
      },
    ],
    [
      "unknown schema",
      (receipt) => {
        receipt.schemaVersion = 2;
      },
    ],
    [
      "wrong package",
      (receipt) => {
        receipt.package.name = "@other/sdk";
      },
    ],
    [
      "placeholder version",
      (receipt) => {
        receipt.package.version = "0.0.0";
      },
    ],
    [
      "unsafe commit",
      (receipt) => {
        receipt.source.commit = "ref\nsecret-value";
      },
    ],
    [
      "creation-host artifact path",
      (receipt) => {
        Object.assign(receipt.artifact, { realpath: "/creation-host/artifact.tgz" });
      },
    ],
    [
      "invalid SHA-256",
      (receipt) => {
        receipt.artifact.sha256 = "not-a-digest";
      },
    ],
    [
      "invalid integrity",
      (receipt) => {
        receipt.artifact.integrity = "sha512-no";
      },
    ],
    [
      "invalid shasum",
      (receipt) => {
        receipt.artifact.shasum = "not-a-digest";
      },
    ],
    [
      "missing files",
      (receipt) => {
        Reflect.deleteProperty(receipt, "files");
      },
    ],
    [
      "empty files",
      (receipt) => {
        receipt.files = [];
      },
    ],
    [
      "unsafe file path",
      (receipt) => {
        firstReceiptFile(receipt).path = "../escape";
      },
    ],
    [
      "non-web-safe file path",
      (receipt) => {
        firstReceiptFile(receipt).path = "dist\\index.js";
      },
    ],
    [
      "duplicate file",
      (receipt) => {
        receipt.files.push({ ...firstReceiptFile(receipt) });
      },
    ],
    [
      "unsorted files",
      (receipt) => {
        receipt.files.reverse();
      },
    ],
    [
      "invalid mode",
      (receipt) => {
        firstReceiptFile(receipt).mode = -1;
      },
    ],
    [
      "invalid file size",
      (receipt) => {
        firstReceiptFile(receipt).size = 1.5;
      },
    ],
    [
      "unknown top-level field",
      (receipt) => {
        Object.assign(receipt, { unexpected: "receipt schema must remain deterministic" });
      },
    ],
    [
      "unknown file field",
      (receipt) => {
        Object.assign(firstReceiptFile(receipt), { unexpected: true });
      },
    ],
  ] as const;

it.each(
  malformedReceiptMutations,
)("verify fails closed for a malformed receipt: %s", (_name, mutate) => {
  const { out, ref, repository } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);
  const receiptFile = path.join(out, "release-artifact-receipt.json");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as TestReceipt;
  mutate(receipt);
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

  const verified = verifyArtifact(repository, out);

  expect(verified.status).toBe(1);
  expect(verified.stderr).toBe("[release-artifact] ERROR Receipt is malformed\n");
  expect(verified.stderr).not.toContain("secret-value");
});

it("requires the verified tarball and receipt to be regular sibling files", () => {
  const { out, ref, repository, scratch } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);
  const other = path.join(scratch, "downloaded-receipt");
  mkdirSync(other);
  const copiedReceipt = path.join(other, "release-artifact-receipt.json");
  copyFileSync(path.join(out, "release-artifact-receipt.json"), copiedReceipt);

  const verified = spawnSync(
    process.execPath,
    [
      cli,
      "verify",
      "--tarball",
      path.join(out, "solwyn-sdk-1.2.3-rc.1.tgz"),
      "--receipt",
      copiedReceipt,
    ],
    { cwd: repository, encoding: "utf8", env: { ...process.env, PATH: "" } },
  );

  expect(verified.status).toBe(1);
  expect(verified.stderr).toBe(
    "[release-artifact] ERROR Tarball and receipt must be regular sibling files\n",
  );
});

it("rejects same-size changes to the downloaded tarball", () => {
  const { out, ref, repository } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);
  const tarball = path.join(out, "solwyn-sdk-1.2.3-rc.1.tgz");
  const changed = readFileSync(tarball);
  changed[0] = (changed[0] ?? 0) ^ 0xff;
  writeFileSync(tarball, changed);

  const verified = verifyArtifact(repository, out);

  expect(verified.status).toBe(1);
  expect(verified.stderr).toBe("[release-artifact] ERROR Tarball SHA-256 mismatch\n");
});

it("rejects malformed receipt JSON without leaking its contents", () => {
  const { out, ref, repository } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);
  writeFileSync(path.join(out, "release-artifact-receipt.json"), '{"unexpected":"secret-value"');

  const verified = verifyArtifact(repository, out);

  expect(verified.status).toBe(1);
  expect(verified.stderr).toBe("[release-artifact] ERROR Receipt is malformed\n");
  expect(verified.stderr).not.toContain("secret-value");
});

it("verifies an artifact after its directory moves and emits trusted workflow paths", () => {
  const { out, ref, repository, scratch } = fixture();
  const created = createArtifact(repository, out, "HEAD");
  expect(created.status, created.stderr).toBe(0);
  const downloaded = path.join(scratch, "downloaded-artifact");
  renameSync(out, downloaded);
  const githubEnv = path.join(scratch, "github-env");

  const verified = verifyDirectory(repository, downloaded, ref, "1.2.3-rc.1", githubEnv);

  expect(verified.status, verified.stderr).toBe(0);
  expect(verified.stdout).toBe(
    "verified solwyn-sdk-1.2.3-rc.1.tgz against release-artifact-receipt.json\n",
  );
  const resolvedDownload = realpathSync(downloaded);
  expect(readFileSync(githubEnv, "utf8")).toBe(
    `TARBALL=${path.join(resolvedDownload, "solwyn-sdk-1.2.3-rc.1.tgz")}\n` +
      `RECEIPT=${path.join(resolvedDownload, "release-artifact-receipt.json")}\n`,
  );
});

it("rejects extra directory entries before emitting workflow paths", () => {
  const { out, ref, repository, scratch } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);
  writeFileSync(path.join(out, "unexpected.txt"), "unexpected");
  const githubEnv = path.join(scratch, "github-env");

  const verified = verifyDirectory(repository, out, ref, "1.2.3-rc.1", githubEnv);

  expect(verified.status).toBe(1);
  expect(verified.stderr).toBe(
    "[release-artifact] ERROR Artifact directory must contain exactly one tarball and one receipt\n",
  );
  expect(existsSync(githubEnv)).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "rejects a symlinked receipt before emitting workflow paths",
  () => {
    const { out, ref, repository, scratch } = fixture();
    const created = createArtifact(repository, out, ref);
    expect(created.status, created.stderr).toBe(0);
    const receipt = path.join(out, "release-artifact-receipt.json");
    const movedReceipt = path.join(scratch, "moved-receipt.json");
    renameSync(receipt, movedReceipt);
    symlinkSync(movedReceipt, receipt);
    const githubEnv = path.join(scratch, "github-env");

    const verified = verifyDirectory(repository, out, ref, "1.2.3-rc.1", githubEnv);

    expect(verified.status).toBe(1);
    expect(verified.stderr).toBe(
      "[release-artifact] ERROR Tarball and receipt must be regular sibling files\n",
    );
    expect(existsSync(githubEnv)).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a dangling symlinked GitHub environment file without creating its target",
  () => {
    const { out, ref, repository, scratch } = fixture();
    const created = createArtifact(repository, out, ref);
    expect(created.status, created.stderr).toBe(0);
    const target = path.join(scratch, "must-not-be-created");
    const githubEnv = path.join(scratch, "github-env-link");
    symlinkSync(target, githubEnv);

    const verified = verifyDirectory(repository, out, ref, "1.2.3-rc.1", githubEnv);

    expect(verified.status).toBe(1);
    expect(verified.stderr).toBe("[release-artifact] ERROR --github-env must be a regular file\n");
    expect(existsSync(target)).toBe(false);
  },
);

it("rejects a non-regular GitHub environment path without changing it", () => {
  const { out, ref, repository, scratch } = fixture();
  const created = createArtifact(repository, out, ref);
  expect(created.status, created.stderr).toBe(0);
  const githubEnv = path.join(scratch, "github-env-directory");
  mkdirSync(githubEnv);
  writeFileSync(path.join(githubEnv, "sentinel"), "unchanged\n");

  const verified = verifyDirectory(repository, out, ref, "1.2.3-rc.1", githubEnv);

  expect(verified.status).toBe(1);
  expect(verified.stderr).toBe("[release-artifact] ERROR --github-env must be a regular file\n");
  expect(readdirSync(githubEnv)).toEqual(["sentinel"]);
  expect(readFileSync(path.join(githubEnv, "sentinel"), "utf8")).toBe("unchanged\n");
});
