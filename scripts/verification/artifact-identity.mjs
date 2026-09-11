/** Side-effect-free installed-artifact identity source and report validation. */
import assert from "node:assert/strict";
import path from "node:path";

export const allInstalledEntries = [
  { specifier: "@solwyn/sdk", binding: "sdk", version: true },
  { specifier: "@solwyn/sdk/node", binding: "node", version: true },
  { specifier: "@solwyn/sdk/testing", binding: "testing" },
  { specifier: "@solwyn/sdk/ai-sdk", binding: "ai" },
];

export const allInstalledSpecifiers = allInstalledEntries.map(({ specifier }) => specifier);
export const runValidationFixtures = Object.freeze([
  "package-identity-remediation.mjs",
  "post-remediation-errors.mjs",
]);

export function installedArtifactIdentitySource(entries, outputBinding, formatExpression) {
  assert.ok(Array.isArray(entries) && entries.length > 0);
  assert.match(outputBinding, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  assert.match(formatExpression, /^(?:format|['"](?:esm|cjs)['"])$/);
  for (const entry of entries) {
    assert.match(entry.specifier, /^@solwyn\/sdk(?:\/(?:node|testing|ai-sdk))?$/);
    assert.match(entry.binding, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  }
  const loadedEntries = entries
    .map(({ binding, specifier }) => `[${JSON.stringify(specifier)},${binding}]`)
    .join(",");
  const versionEntries = entries
    .filter(({ version }) => version === true)
    .map(({ binding, specifier }) => `[${JSON.stringify(specifier)},${binding}]`)
    .join(",");
  return `{
const identityAssert=(await import('node:assert/strict')).default;
const identityFs=(await import('node:fs')).default;
const identityPath=(await import('node:path')).default;
const {createRequire:identityCreateRequire}=await import('node:module');
const {fileURLToPath:identityFileURLToPath}=await import('node:url');
const identityRequire=identityCreateRequire(import.meta.url);
const identityFormat=${formatExpression};
const identityManifestPath=identityFs.realpathSync(identityRequire.resolve('@solwyn/sdk/package.json'));
const identityConsumerRealpath=identityFs.realpathSync(process.cwd());
const identityInside=(parent,child)=>{const relative=identityPath.relative(parent,child);return relative!==''&&!relative.startsWith('..'+identityPath.sep)&&relative!=='..'&&!identityPath.isAbsolute(relative);};
identityAssert.ok(identityInside(identityConsumerRealpath,identityManifestPath),'@solwyn/sdk manifest must resolve beneath the consumer');
const identityManifest=identityRequire(identityManifestPath);
const identityPackageRoot=identityPath.dirname(identityManifestPath);
identityAssert.equal(identityManifest.name,'@solwyn/sdk');
const identityEntryRealpaths={};
for(const [identityEntry,identityApi] of [${loadedEntries}]){
  identityAssert.ok(identityApi&&(typeof identityApi==='object'||typeof identityApi==='function'),identityEntry+' must load');
  const identityTarget=identityFs.realpathSync(identityFormat==='esm'?identityFileURLToPath(import.meta.resolve(identityEntry)):identityRequire.resolve(identityEntry));
  identityAssert.ok(identityInside(identityPackageRoot,identityTarget),identityEntry+' must resolve beneath the installed package manifest');
  identityEntryRealpaths[identityEntry]=identityTarget;
}
const identityVersions={};
for(const [identityEntry,identityApi] of [${versionEntries}]){
  identityAssert.equal(identityApi.VERSION,identityManifest.version,identityEntry+' VERSION must equal the installed package manifest version');
  identityVersions[identityEntry]=identityApi.VERSION;
}
${outputBinding}={format:identityFormat,version:identityManifest.version,manifestWithinConsumer:true,consumerRealpath:identityConsumerRealpath,manifestRealpath:identityManifestPath,entries:${JSON.stringify(entries.map(({ specifier }) => specifier))},entryRealpaths:identityEntryRealpaths,versions:identityVersions};
}`;
}

export function runValidationWrapperSource() {
  return `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [fixture,sdkRoot,format,identityOutput]=process.argv.slice(2);
const req=createRequire(import.meta.url);
const load=name=>format==='cjs'?req(name):import(name);
const sdk=await load('@solwyn/sdk');
const node=await load('@solwyn/sdk/node');
const testing=await load('@solwyn/sdk/testing');
const ai=await load('@solwyn/sdk/ai-sdk');
let artifactIdentity;
${installedArtifactIdentitySource(allInstalledEntries, "artifactIdentity", "format")}
assert.equal(fs.realpathSync(sdkRoot),fs.realpathSync(path.dirname(req.resolve('@solwyn/sdk/package.json'))),'Run validation must use the installed package identified by its consumer manifest');
process.argv=[process.argv[0],fixture,sdkRoot,format];
await import(pathToFileURL(fixture).href);
assert.ok(path.isAbsolute(identityOutput),'Run-validation identity output must be absolute');
fs.writeFileSync(identityOutput,JSON.stringify({fixture:path.basename(fixture),artifactIdentity}));
`;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertObservedArtifactIdentity(
  identity,
  { entries = allInstalledSpecifiers, format, version },
) {
  assert.deepEqual(
    Object.keys(identity).sort(),
    [
      "consumerRealpath",
      "entries",
      "entryRealpaths",
      "format",
      "manifestRealpath",
      "manifestWithinConsumer",
      "version",
      "versions",
    ].sort(),
  );
  assert.equal(identity.format, format);
  assert.equal(identity.version, version);
  assert.equal(identity.manifestWithinConsumer, true);
  assert.ok(path.isAbsolute(identity.consumerRealpath));
  assert.ok(path.isAbsolute(identity.manifestRealpath));
  assert.ok(
    inside(identity.consumerRealpath, identity.manifestRealpath),
    "Installed manifest evidence must remain beneath the consumer",
  );
  assert.deepEqual(identity.entries, entries);
  assert.deepEqual(Object.keys(identity.entryRealpaths), entries);
  const packageRoot = path.dirname(identity.manifestRealpath);
  for (const entry of entries) {
    const target = identity.entryRealpaths[entry];
    assert.ok(path.isAbsolute(target));
    assert.ok(
      inside(packageRoot, target),
      `${entry} evidence must remain beneath the installed manifest`,
    );
  }
  const versionEntries = entries.filter(
    (entry) => entry === "@solwyn/sdk" || entry === "@solwyn/sdk/node",
  );
  assert.deepEqual(Object.keys(identity.versions), versionEntries);
  for (const entry of versionEntries)
    assert.equal(identity.versions[entry], version, `${entry} VERSION evidence differs`);
}

export function assertPackageArtifactIdentityChecks(checks, version) {
  assert.deepEqual(Object.keys(checks).sort(), [
    "aiHarness",
    "aiPeer",
    "providerFree",
    "providerFreeResolution",
    "runValidation",
    "version",
  ]);
  assert.equal(checks.version, version);
  assertObservedArtifactIdentity(checks.providerFreeResolution, { format: "esm", version });
  for (const [name, identities] of [
    ["providerFree", checks.providerFree],
    ["aiPeer", checks.aiPeer],
  ]) {
    assert.equal(identities.length, 2, `${name} must contain both formats`);
    for (const [index, format] of ["esm", "cjs"].entries())
      assertObservedArtifactIdentity(identities[index], { format, version });
  }
  assert.equal(checks.runValidation.length, 4);
  let index = 0;
  for (const format of ["esm", "cjs"])
    for (const fixture of runValidationFixtures) {
      const observed = checks.runValidation[index++];
      assert.deepEqual(Object.keys(observed).sort(), ["artifactIdentity", "fixture"]);
      assert.equal(observed.fixture, fixture);
      assertObservedArtifactIdentity(observed.artifactIdentity, { format, version });
    }
  assert.equal(checks.aiHarness.length, 2);
  for (const [harnessIndex, format] of ["esm", "cjs"].entries()) {
    const observed = checks.aiHarness[harnessIndex];
    assert.deepEqual(Object.keys(observed).sort(), ["artifactIdentity", "format"]);
    assert.equal(observed.format, format);
    assertObservedArtifactIdentity(observed.artifactIdentity, { format, version });
  }
  assert.deepEqual(
    checks.providerFree.map(({ version: observed }) => observed),
    [version, version],
    "Package consumer artifact identity evidence is incomplete",
  );
}

const runtimeArtifactEntries = {
  "provider-free-runtime": allInstalledSpecifiers,
  "mixed-format-enforcement-identity": allInstalledSpecifiers,
  "native-anthropic-promise": ["@solwyn/sdk", "@solwyn/sdk/testing"],
  "native-foreign-aws": ["@solwyn/sdk"],
  "post-remediation-errors": allInstalledSpecifiers,
};

export function assertRuntimeChecks(checks, sdkVersion = checks.artifactIdentity?.version) {
  assert.deepEqual(Object.keys(checks).sort(), ["artifactIdentity", "cells", "runtimes"]);
  assert.ok(Array.isArray(checks.runtimes) && checks.runtimes.length > 0);
  assert.equal(
    new Set(checks.runtimes.map((runtime) => runtime.binary)).size,
    checks.runtimes.length,
  );
  assert.ok(typeof sdkVersion === "string" && sdkVersion.length > 0);
  assertObservedArtifactIdentity(checks.artifactIdentity, {
    entries: allInstalledSpecifiers,
    format: "esm",
    version: sdkVersion,
  });
  const expected = [];
  for (const { binary, version } of checks.runtimes) {
    assert.ok(path.isAbsolute(binary));
    assert.match(version, /^v\d+\.\d+\.\d+$/);
    for (const format of ["esm", "cjs"]) {
      for (const [name, result] of [
        [
          "provider-free-runtime",
          {
            format,
            dispatched: 1,
            check: 1,
            confirm: 1,
            ingest: 1,
            attributed: true,
            aiRuntimeWithoutPeer: true,
          },
        ],
        [
          "mixed-format-enforcement-identity",
          {
            firstFormat: format,
            denied: 6,
            dispatches: 0,
            checks: 6,
            ingested: 6,
            sharedBrands: true,
          },
        ],
        [
          "native-anthropic-promise",
          { format, dispatches: 1, confirms: 1, ingested: 1, ordinaryPromise: true },
        ],
        [
          "native-foreign-aws",
          {
            results: ["bedrock-control", "bedrock-control-subclass", "s3", "s3-subclass"].map(
              (family) => ({ format, family, rejected: true }),
            ),
            requests: 0,
            network: "none; constructors and synchronous detection only",
          },
        ],
        ["post-remediation-errors", { families: 11, denied: 8, stopped: 8, middlewareDenied: 2 }],
      ])
        expected.push({ binary, version, name, format, status: 0, result });
    }
  }
  assert.equal(checks.cells.length, expected.length);
  for (const [index, expectedCell] of expected.entries()) {
    const cell = checks.cells[index];
    assert.deepEqual(Object.keys(cell).sort(), [
      "artifactIdentity",
      "binary",
      "format",
      "name",
      "result",
      "status",
      "version",
    ]);
    const { artifactIdentity, ...semanticCell } = cell;
    assert.deepEqual(
      semanticCell,
      expectedCell,
      "Runtime cells must prove every format and semantic outcome",
    );
    assertObservedArtifactIdentity(artifactIdentity, {
      entries: runtimeArtifactEntries[cell.name],
      format: cell.format,
      version: sdkVersion,
    });
  }
}
