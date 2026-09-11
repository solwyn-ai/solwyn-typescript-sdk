import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const identityHelper = new URL("../../scripts/verification/artifact-identity.mjs", import.meta.url)
  .href;
const expectedEntries = [
  "@solwyn/sdk",
  "@solwyn/sdk/node",
  "@solwyn/sdk/testing",
  "@solwyn/sdk/ai-sdk",
];
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("imports the identity helper without mutating the environment", () => {
  const program = `
import assert from 'node:assert/strict';
process.env.Node_Path='sentinel';
await import(${JSON.stringify(identityHelper)});
assert.equal(process.env.Node_Path,'sentinel');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
});

it("owns the shared run-validation fixture catalog and wrapper source", async () => {
  const module = (await import(identityHelper)) as {
    runValidationFixtures?: readonly string[];
    runValidationWrapperSource?: () => string;
  };
  expect(module.runValidationFixtures).toEqual([
    "package-identity-remediation.mjs",
    "post-remediation-errors.mjs",
  ]);
  expect(module.runValidationWrapperSource).toBeTypeOf("function");
  const source = module.runValidationWrapperSource?.() ?? "";
  expect(source).toContain("Run validation must use the installed package");
  expect(source).toContain("fs.writeFileSync(identityOutput");

  for (const file of ["package-consumers.mjs", "runtime-matrix.mjs"]) {
    const probe = readFileSync(
      new URL(`../../scripts/verification/${file}`, import.meta.url),
      "utf8",
    );
    expect(probe).toContain("runValidationWrapperSource");
    expect(probe).toContain("runValidationFixtures");
    expect(probe).not.toMatch(/export\s*\{[^}]*assert(?:PackageArtifactIdentity|Runtime)Checks/s);
  }
});

async function identitySource() {
  const module = (await import(identityHelper)) as {
    installedArtifactIdentitySource?: (
      entries: Array<{ binding: string; specifier: string; version?: boolean }>,
      outputBinding: string,
      formatExpression: string,
    ) => string;
  };
  expect(module.installedArtifactIdentitySource).toBeTypeOf("function");
  if (module.installedArtifactIdentitySource === undefined)
    throw new Error("installedArtifactIdentitySource is unavailable");
  return module.installedArtifactIdentitySource(
    [
      { specifier: "@solwyn/sdk", binding: "sdk", version: true },
      { specifier: "@solwyn/sdk/node", binding: "node", version: true },
      { specifier: "@solwyn/sdk/testing", binding: "testing" },
      { specifier: "@solwyn/sdk/ai-sdk", binding: "ai" },
    ],
    "artifactIdentity",
    "format",
  );
}

function createConsumer({
  manifestVersion = "7.6.5",
  coreVersion = manifestVersion,
  nodeVersion = manifestVersion,
  esmCoreOutside = false,
  missingCoreVersion = false,
  missingNodeVersion = false,
}: {
  manifestVersion?: string;
  coreVersion?: string;
  nodeVersion?: string;
  esmCoreOutside?: boolean;
  missingCoreVersion?: boolean;
  missingNodeVersion?: boolean;
} = {}) {
  const app = mkdtempSync(path.join(tmpdir(), "verification-artifact-identity-"));
  temporary.push(app);
  const sdk = path.join(app, "node_modules/@solwyn/sdk");
  mkdirSync(sdk, { recursive: true });
  const exports = {
    ".": { import: esmCoreOutside ? "./esm/index.mjs" : "./index.mjs", require: "./index.cjs" },
    "./node": { import: "./node.mjs", require: "./node.cjs" },
    "./testing": { import: "./testing.mjs", require: "./testing.cjs" },
    "./ai-sdk": { import: "./ai-sdk.mjs", require: "./ai-sdk.cjs" },
    "./package.json": "./package.json",
  };
  writeFileSync(
    path.join(sdk, "package.json"),
    JSON.stringify({ name: "@solwyn/sdk", version: manifestVersion, type: "module", exports }),
  );
  for (const [entry, version] of [
    ["index", coreVersion],
    ["node", nodeVersion],
  ]) {
    const missingVersion =
      (entry === "index" && missingCoreVersion) || (entry === "node" && missingNodeVersion);
    const esmSource = missingVersion
      ? "export const loaded=true;"
      : `export const VERSION=${JSON.stringify(version)};`;
    const cjsSource = missingVersion
      ? "exports.loaded=true;"
      : `exports.VERSION=${JSON.stringify(version)};`;
    if (entry === "index" && esmCoreOutside) {
      const external = path.join(app, "external-esm");
      mkdirSync(external);
      writeFileSync(path.join(external, "index.mjs"), esmSource);
      symlinkSync(
        external,
        path.join(sdk, "esm"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } else {
      writeFileSync(path.join(sdk, `${entry}.mjs`), esmSource);
    }
    writeFileSync(path.join(sdk, `${entry}.cjs`), cjsSource);
  }
  for (const entry of ["testing", "ai-sdk"]) {
    writeFileSync(path.join(sdk, `${entry}.mjs`), "export const loaded=true;");
    writeFileSync(path.join(sdk, `${entry}.cjs`), "exports.loaded=true;");
  }
  writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
  );
  return app;
}

async function runIdentity(app: string, format: "esm" | "cjs", cwd = app) {
  const source = await identitySource();
  const program = `
import {createRequire} from 'node:module';
const req=createRequire(import.meta.url);
const format=process.argv[2];
const load=name=>format==='cjs'?req(name):import(name);
const sdk=await load('@solwyn/sdk');
const node=await load('@solwyn/sdk/node');
const testing=await load('@solwyn/sdk/testing');
const ai=await load('@solwyn/sdk/ai-sdk');
let artifactIdentity;
${source}
process.stdout.write(JSON.stringify(artifactIdentity));
`;
  const script = path.join(app, "consumer.mjs");
  writeFileSync(script, program);
  return spawnSync(process.execPath, [script, format], { cwd, encoding: "utf8" });
}

it.each([
  "esm",
  "cjs",
] as const)("%s proves core and node VERSION values against the installed manifest", async (format) => {
  const app = createConsumer();
  const result = await runIdentity(app, format);
  expect(result.status, result.stderr).toBe(0);
  const sdk = path.join(app, "node_modules/@solwyn/sdk");
  expect(JSON.parse(result.stdout)).toEqual({
    format,
    version: "7.6.5",
    manifestWithinConsumer: true,
    consumerRealpath: realpathSync(app),
    manifestRealpath: realpathSync(path.join(sdk, "package.json")),
    entries: expectedEntries,
    entryRealpaths: Object.fromEntries(
      ["index", "node", "testing", "ai-sdk"].map((entry, index) => [
        expectedEntries[index],
        realpathSync(path.join(sdk, `${entry}.${format === "esm" ? "mjs" : "cjs"}`)),
      ]),
    ),
    versions: { "@solwyn/sdk": "7.6.5", "@solwyn/sdk/node": "7.6.5" },
  });
});

it.each(
  (["esm", "cjs"] as const).flatMap((format) =>
    (
      [
        ["stale core", { coreVersion: "7.6.4" }, "@solwyn/sdk VERSION"],
        ["stale node", { nodeVersion: "7.6.4" }, "@solwyn/sdk/node VERSION"],
        ["missing core", { missingCoreVersion: true }, "@solwyn/sdk VERSION"],
        ["missing node", { missingNodeVersion: true }, "@solwyn/sdk/node VERSION"],
      ] as const
    ).map(([entry, options, message]) => [`${format} ${entry}`, format, options, message] as const),
  ),
)("%s rejects an invalid installed VERSION export", async (_label, format, options, message) => {
  const result = await runIdentity(createConsumer(options), format);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
});

it("validates the target for the selected module format", async () => {
  const app = createConsumer({ esmCoreOutside: true });
  const cjs = await runIdentity(app, "cjs");
  expect(cjs.status, cjs.stderr).toBe(0);
  const esm = await runIdentity(app, "esm");
  expect(esm.status).toBe(1);
  expect(esm.stderr).toContain("@solwyn/sdk must resolve beneath the installed package manifest");
});

it("rejects a package manifest outside the consumer realpath", async () => {
  const app = createConsumer();
  const other = mkdtempSync(path.join(tmpdir(), "verification-artifact-identity-cwd-"));
  temporary.push(other);
  const result = await runIdentity(app, "esm", other);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("manifest must resolve beneath the consumer");
});

it("requires complete canonical package-consumer artifact identity evidence", async () => {
  const module = (await import(identityHelper)) as {
    assertPackageArtifactIdentityChecks?: (checks: unknown, version: string) => void;
  };
  expect(module.assertPackageArtifactIdentityChecks).toBeTypeOf("function");
  if (module.assertPackageArtifactIdentityChecks === undefined)
    throw new Error("assertPackageArtifactIdentityChecks is unavailable");
  const cell = (format: "esm" | "cjs", consumer: string) => {
    const consumerRealpath = path.resolve(path.parse(process.cwd()).root, "identity", consumer);
    const packageRoot = path.join(consumerRealpath, "node_modules/@solwyn/sdk");
    return {
      format,
      version: "7.6.5",
      manifestWithinConsumer: true,
      consumerRealpath,
      manifestRealpath: path.join(packageRoot, "package.json"),
      entries: expectedEntries,
      entryRealpaths: Object.fromEntries(
        expectedEntries.map((specifier, index) => [
          specifier,
          path.join(packageRoot, "dist", `${index}.${format === "esm" ? "js" : "cjs"}`),
        ]),
      ),
      versions: { "@solwyn/sdk": "7.6.5", "@solwyn/sdk/node": "7.6.5" },
    };
  };
  const checks = {
    version: "7.6.5",
    providerFreeResolution: cell("esm", "provider-free"),
    providerFree: [cell("esm", "provider-free"), cell("cjs", "provider-free")],
    aiPeer: [cell("esm", "ai-peer"), cell("cjs", "ai-peer")],
    runValidation: [
      {
        fixture: "package-identity-remediation.mjs",
        artifactIdentity: cell("esm", "provider-free"),
      },
      {
        fixture: "post-remediation-errors.mjs",
        artifactIdentity: cell("esm", "provider-free"),
      },
      {
        fixture: "package-identity-remediation.mjs",
        artifactIdentity: cell("cjs", "provider-free"),
      },
      {
        fixture: "post-remediation-errors.mjs",
        artifactIdentity: cell("cjs", "provider-free"),
      },
    ],
    aiHarness: [
      {
        format: "esm",
        artifactIdentity: cell("esm", "provider-free"),
      },
      {
        format: "cjs",
        artifactIdentity: cell("cjs", "provider-free"),
      },
    ],
  };
  expect(() => module.assertPackageArtifactIdentityChecks?.(checks, "7.6.5")).not.toThrow();
  for (const mutation of [
    (value: typeof checks) => {
      value.version = "7.6.4";
    },
    (value: typeof checks) => {
      value.providerFree.pop();
    },
    (value: typeof checks) => {
      value.providerFreeResolution.manifestRealpath = path.resolve(
        path.parse(process.cwd()).root,
        "outside/package.json",
      );
    },
    (value: typeof checks) => {
      const aiPeer = value.aiPeer.at(0);
      if (aiPeer === undefined) throw new Error("Missing AI peer cell");
      aiPeer.versions["@solwyn/sdk"] = "7.6.4";
    },
    (value: typeof checks) => {
      value.runValidation.pop();
    },
    (value: typeof checks) => {
      const harness = value.aiHarness.at(1);
      if (harness === undefined) throw new Error("Missing AI harness cell");
      harness.artifactIdentity.entryRealpaths["@solwyn/sdk"] = path.resolve(
        path.parse(process.cwd()).root,
        "outside/index.cjs",
      );
    },
  ]) {
    const changed = structuredClone(checks);
    mutation(changed);
    expect(() => module.assertPackageArtifactIdentityChecks?.(changed, "7.6.5")).toThrow();
  }
});
