/** Installed-package checks. Runtime requests use the SDK's offline control-plane fixture. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  allInstalledEntries,
  assertPackageArtifactIdentityChecks,
  installedArtifactIdentitySource,
  runValidationFixtures,
  runValidationWrapperSource,
} from "./artifact-identity.mjs";
import { classifyCommandFailure, runBoundedCommand } from "./process.mjs";
import {
  extractReadmeAiConsumer,
  readmeAiLockedVersions,
  resolveReadmeAiPackages,
} from "./readme-consumer.mjs";
import {
  createReport,
  createTemporaryRoot,
  failureFor,
  finalizeReport,
  parseArguments,
  repositoryRoot,
  sha256,
  verificationEnv,
  writeReport,
} from "./support.mjs";

const root = repositoryRoot;
const repositoryRequire = createRequire(path.join(root, "package.json"));
const env = verificationEnv();

export function aiHarnessArguments(sdkPath, format, identityOutput) {
  const args = [
    "ai-sdk-harness.mjs",
    pathToFileURL(path.join(sdkPath, `dist/ai-sdk/index.${format === "esm" ? "js" : "cjs"}`)).href,
    format,
  ];
  if (identityOutput !== undefined) args.push(identityOutput);
  return args;
}

/** Reviewed publication shape. Content hashes may change; additions/removals require review. */
export function assertPackageInventory(listing) {
  const files = Array.isArray(listing)
    ? listing
    : listing
        .trim()
        .split(/\r?\n/)
        .filter((name) => !name.endsWith("/"));
  const expected = [
    "package/LICENSE",
    "package/README.md",
    "package/CHANGELOG.md",
    "package/package.json",
  ];
  for (const entry of ["index", "node", "ai-sdk/index", "testing/index"])
    for (const extension of ["js", "cjs", "js.map", "cjs.map", "d.ts", "d.cts"])
      expected.push(`package/dist/${entry}.${extension}`);
  for (const provider of [
    "anthropic",
    "bedrock",
    "google",
    "openai",
    "openai-compatible",
    "together",
  ])
    for (const extension of ["js", "cjs", "js.map", "cjs.map"])
      expected.push(`package/dist/${provider}-HASH.${extension}`);
  for (let index = 0; index < 8; index++)
    for (const extension of ["js", "cjs", "js.map", "cjs.map"])
      expected.push(`package/dist/chunk-HASH.${extension}`);
  for (const declaration of ["proxies", "types"])
    for (const extension of ["d.ts", "d.cts"])
      expected.push(`package/dist/${declaration}-HASH.${extension}`);
  const normalized = files.map((file) =>
    file.replace(/-([A-Za-z0-9_-]{8})(?=\.(?:cjs|js|d\.cts|d\.ts)(?:\.map)?$)/, "-HASH"),
  );
  assert.equal(new Set(files).size, files.length, "Duplicate tarball entries");
  for (const file of files)
    if (/\.(?:js|cjs)$/.test(file))
      assert.ok(files.includes(`${file}.map`), `Missing matching sourcemap for ${file}`);
  assert.deepEqual(
    normalized.sort(),
    expected.sort(),
    "Package inventory differs from the reviewed 88-file publication shape",
  );
  return { expectedCount: expected.length, actualCount: files.length, verified: true };
}

export function assertLockedDependencies(app, lock) {
  const actual = [];
  function visitPackage(location) {
    const stat = fs.lstatSync(location);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      `Installed package must be a real directory: ${location}`,
    );
    actual.push(path.relative(app, location).split(path.sep).join("/"));
    visitModules(path.join(location, "node_modules"));
  }
  function visitModules(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const location = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        assert.ok(
          entry.isDirectory() && !entry.isSymbolicLink(),
          `Installed scope must be a real directory: ${location}`,
        );
        for (const scoped of fs.readdirSync(location)) visitPackage(path.join(location, scoped));
      } else visitPackage(location);
    }
  }
  visitModules(path.join(app, "node_modules"));
  assert.deepEqual(
    actual.sort(),
    [...Object.keys(lock.packages).filter(Boolean), "node_modules/@solwyn/sdk"].sort(),
    "Installed dependency tree differs from the lock plus reviewed SDK",
  );
  const installed = {};
  for (const [relative, expected] of Object.entries(lock.packages)) {
    if (!relative) continue;
    assert.ok(relative.startsWith("node_modules/") && !relative.split("/").includes(".."));
    assert.match(expected.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(expected.integrity, /^sha512-/);
    const location = path.join(app, relative);
    assert.equal(fs.lstatSync(location).isSymbolicLink(), false, `${relative} must not be linked`);
    const realpath = fs.realpathSync(location);
    assert.ok(realpath.startsWith(`${fs.realpathSync(app)}${path.sep}`));
    const manifest = JSON.parse(fs.readFileSync(path.join(location, "package.json"), "utf8"));
    assert.equal(
      manifest.version,
      expected.version,
      `${relative} differs from the checked-in lock`,
    );
    installed[relative] = { version: manifest.version, realpath };
  }
  return installed;
}

const entryIdentityRuntime = `
import {createRequire} from 'node:module';
const req=createRequire(import.meta.url);
const format=process.argv[2];
const load=name=>format==='cjs'?req(name):import(name);
const sdk=await load('@solwyn/sdk');
const node=await load('@solwyn/sdk/node');
const testing=await load('@solwyn/sdk/testing');
const ai=await load('@solwyn/sdk/ai-sdk');
let artifactIdentity;
${installedArtifactIdentitySource(allInstalledEntries, "artifactIdentity", "format")}
process.stdout.write(JSON.stringify({format,...artifactIdentity})+'\\n');
`;

const aiHarnessRunner = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const [entry,format,identityOutput]=process.argv.slice(2);
const req=createRequire(import.meta.url);
const load=name=>format==='cjs'?req(name):import(name);
const sdk=await load('@solwyn/sdk');
const node=await load('@solwyn/sdk/node');
const testing=await load('@solwyn/sdk/testing');
const ai=await load('@solwyn/sdk/ai-sdk');
let artifactIdentity;
${installedArtifactIdentitySource(allInstalledEntries, "artifactIdentity", "format")}
const packageRoot=fs.realpathSync(path.dirname(req.resolve('@solwyn/sdk/package.json')));
const entryRealpath=fs.realpathSync(fileURLToPath(entry));
const entryRelative=path.relative(packageRoot,entryRealpath);
assert.ok(entryRelative!==''&&!entryRelative.startsWith('..'+path.sep)&&entryRelative!=='..'&&!path.isAbsolute(entryRelative),'AI harness entry must resolve beneath the installed package manifest');
assert.equal(entryRealpath,artifactIdentity.entryRealpaths['@solwyn/sdk/ai-sdk'],'AI harness entry must equal the installed public AI SDK export target');
await import(pathToFileURL(path.join(process.cwd(),'ai-sdk-harness-implementation.mjs')).href);
assert.ok(path.isAbsolute(identityOutput),'AI harness identity output must be absolute');
fs.writeFileSync(identityOutput,JSON.stringify({format,artifactIdentity}));
`;

const runtime = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const format = process.argv[2];
const load = name => format === 'cjs' ? require(name) : import(name);
const sdk = await load('@solwyn/sdk');
const node = await load('@solwyn/sdk/node');
const testing = await load('@solwyn/sdk/testing');
const ai = await load('@solwyn/sdk/ai-sdk');
let artifactIdentity;
${installedArtifactIdentitySource(allInstalledEntries, "artifactIdentity", "format")}
const plane = new testing.FakeControlPlane();
const options = {apiKey:plane.apiKey, apiUrl:plane.apiUrl, fetch:plane.fetch, leaseEnabled:false, budgetCheckCacheTtl:0, logger:sdk.noopLogger, reportUntrackedSurfaces:false};
let dispatches = 0;
const provider = {chat:{completions:{create(){dispatches++; return {id:'packed-response',usage:{prompt_tokens:2,completion_tokens:3}};}}}};
const client = new sdk.Solwyn(provider, options);
await node.run('consumer-review', async () => {
  const response = await client.chat.completions.create({model:'gpt-review'});
  assert.equal(response.id, 'packed-response');
});
await client.close();
assert.equal(plane.checks.length,1);
assert.equal(plane.confirms.length,1);
assert.equal(plane.ingested.length,1);
assert.equal(typeof plane.checks[0].agent_run_id,'string');
assert.equal(plane.ingested[0].agent_run_name,'consumer-review');
const handle = ai.createSolwynMiddleware({apiKey:plane.apiKey,apiUrl:plane.apiUrl,fetch:plane.fetch,leaseEnabled:false,budgetCheckCacheTtl:0,logger:sdk.noopLogger});
assert.equal(typeof handle.middleware.wrapGenerate,'function');
assert.equal(typeof handle.middleware.wrapStream,'function');
assert.equal(typeof handle[Symbol.asyncDispose],'function');
const usage = {inputTokens:{total:2,noCache:2,cacheRead:0,cacheWrite:0},outputTokens:{total:3,text:3,reasoning:0}};
const args = {model:{provider:'openai',modelId:'gpt-review'}, params:{prompt:[{role:'user',content:[{type:'text',text:'hello'}]}]}};
const buffered = await handle.middleware.wrapGenerate({...args, doGenerate:async()=>{dispatches++;return {content:[{type:'text',text:'done'}],usage};}});
assert.deepEqual(buffered.usage,usage);
const streamed = await handle.middleware.wrapStream({...args,doStream:async()=>{
  dispatches++;
  return {stream:new ReadableStream({start(controller){
    controller.enqueue({type:'text-delta',id:'text',delta:'done'});
    controller.enqueue({type:'finish',finishReason:{unified:'stop',raw:'stop'},usage});
    controller.close();
  }})};
}});
const reader=streamed.stream.getReader();
const chunks=[];
while(true){const next=await reader.read();if(next.done)break;chunks.push(next.value);}
reader.releaseLock();
assert.equal(chunks.length,2);
await handle.close();
assert.equal(dispatches,3);
assert.equal(plane.checks.length,3);
assert.equal(plane.confirms.length,3);
assert.equal(plane.ingested.length,3);
for(const event of plane.ingested){assert.equal(event.input_tokens,2);assert.equal(event.output_tokens,3);}
assert.equal((await (await plane.fetch(plane.apiUrl+'/health')).json()).status,'ok');
for(const name of ['assertCheckContract','assertConfirmContract','assertLeaseContract','assertReceiptIngestContract','assertRunControlContract'])assert.equal(typeof testing[name],'function');
process.stdout.write(JSON.stringify({format,dispatches,checks:3,confirms:3,ingested:3,aiBuffered:true,aiStreaming:true,artifactIdentity})+'\n');
`;

const types = `
import {Solwyn,budgetCheckResult,type FetchLike,type BudgetCheckResult,RunStoppedError,SolwynError,VERSION} from '@solwyn/sdk';
import {run,currentRun,createRun,currentRunContext,VERSION as nodeVersion} from '@solwyn/sdk/node';
import {FakeControlPlane,denialOnlyOpenAIClient,assertCheckContract,assertConfirmContract,assertLeaseContract,assertReceiptIngestContract,assertRunControlContract,type ScenarioWindow,type ContractOptions} from '@solwyn/sdk/testing';
const plane=new FakeControlPlane();
const seam:FetchLike=plane.fetch;
const client=new Solwyn({chat:{completions:{create(_params:{model:string}){return {usage:{prompt_tokens:1,completion_tokens:1}};}}}},{fetch:seam,apiKey:plane.apiKey});
const usage:Promise<{usage:{prompt_tokens:number;completion_tokens:number}}>=client.chat.completions.create({model:'gpt-review'});
const identity:string|undefined=run('review',()=>currentRun()?.agentRunId);
const handle=createRun('review');
const scope:ScenarioWindow=plane.outage({requests:1});
const options:ContractOptions={apiKey:plane.apiKey,apiUrl:plane.apiUrl};
const legacy:BudgetCheckResult={allowed:true,remainingBudget:5,projectId:'legacy',reservationId:'legacy',mode:'alert_only',warning:null,budgetLimit:10,currentUsage:5,priceHints:null,failoverTuningAllowed:null,deniedByPeriod:null};
const budget=budgetCheckResult({allowed:true,remainingBudget:1});
const leaseId:string|null=budget.leaseId;
const leaseClaimToken:number|null=budget.leaseClaimToken;
const failure:SolwynError=new RunStoppedError({agentRunId:'run_review',reason:'review',source:'server'});
const packageVersion:string=VERSION;
const nodePackageVersion:string=nodeVersion;
void [usage,identity,handle,scope,options,budget,legacy,leaseId,leaseClaimToken,failure,currentRunContext,denialOnlyOpenAIClient,assertCheckContract,assertConfirmContract,assertLeaseContract,assertReceiptIngestContract,assertRunControlContract,packageVersion,nodePackageVersion];
`;

export async function runPackageConsumers({ tarball, out }) {
  ({ tarball, out } = parseArguments(["--tarball", tarball, "--out", out]));
  const report = createReport({
    probe: "package-consumers",
    tarball,
    env,
    versions: { node: process.version, nodeBinary: process.execPath, providers: {} },
    details: {
      consumerRetention: env.SMOKE_KEEP === "1" ? "SMOKE_KEEP=1" : "remove-after-cleanup",
      commands: [],
    },
  });
  const resultFile = path.join(out, "package-consumers.json");
  const write = () => writeReport(resultFile, report);
  let consumerRoot;
  write();
  async function run(label, binary, args, cwd = consumerRoot, expectedFailure = false) {
    const record = {
      label,
      binary,
      args,
      cwd,
      state: "running",
      status: null,
      startedAt: new Date().toISOString(),
    };
    report.details.commands.push(record);
    write();
    const result = await runBoundedCommand(binary, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    Object.assign(record, result, {
      error: result.error?.message,
      errorCode: result.error?.code,
      state: "finished",
    });
    if (!expectedFailure && (result.error || result.status !== 0))
      report.failure = classifyCommandFailure(binary, result);
    write();
    assert.ok(!result.error, `${label}: ${result.error?.message}`);
    if (expectedFailure) assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
    else assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`);
    return result;
  }
  async function install(app, artifact) {
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ name: "solwyn-isolated-consumer", version: "1.0.0", private: true }),
    );
    await run(
      "install-provider-free",
      "npm",
      [
        "install",
        artifact,
        "--ignore-scripts",
        "--omit=optional",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--cache",
        path.join(consumerRoot, "npm-cache"),
      ],
      app,
    );
    return createRequire(path.join(app, "package.json"));
  }
  try {
    consumerRoot = createTemporaryRoot("solwyn-consumer-", report, { env });
    report.details.consumerRoot = consumerRoot;
    const app = path.join(consumerRoot, "app");
    const consumerRequire = await install(app, tarball);
    const sdkPath = fs.realpathSync(
      path.dirname(consumerRequire.resolve("@solwyn/sdk/package.json")),
    );
    assert.ok(
      sdkPath.startsWith(`${fs.realpathSync(app)}${path.sep}`),
      "SDK must resolve beneath the temporary consumer",
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(sdkPath, "package.json"), "utf8"));
    const intervals = JSON.parse(
      fs.readFileSync(path.join(root, "tests/provider-surface-intervals.json"), "utf8"),
    );
    const peers = Object.keys(manifest.peerDependencies ?? {});
    const forbidden = [
      ...new Set([
        ...peers,
        ...intervals.include.flatMap((row) =>
          row.packages.map((spec) => spec.slice(0, spec.lastIndexOf("@"))),
        ),
        "js-tiktoken",
        "vitest",
      ]),
    ];
    fs.writeFileSync(
      path.join(app, "isolation.mjs"),
      `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const consumerRequire=createRequire(path.join(process.cwd(),'package.json'));
assert.deepEqual(Object.keys(process.env).filter(key=>key.toUpperCase()==='NODE_PATH'),[]);
const resolved=fs.realpathSync(consumerRequire.resolve('@solwyn/sdk'));
assert.ok(resolved.startsWith(fs.realpathSync(process.cwd())+path.sep));
const sdk=await import('@solwyn/sdk');
const node=await import('@solwyn/sdk/node');
const testing=await import('@solwyn/sdk/testing');
const ai=await import('@solwyn/sdk/ai-sdk');
let artifactIdentity;
${installedArtifactIdentitySource(allInstalledEntries, "artifactIdentity", "'esm'")}
for(const name of ${JSON.stringify(forbidden)})assert.throws(()=>consumerRequire.resolve(name),{code:'MODULE_NOT_FOUND'});
assert.throws(()=>consumerRequire.resolve('openai'),{code:'MODULE_NOT_FOUND'});
process.stdout.write(JSON.stringify({resolved,openaiCannotResolve:true,artifactIdentity})+'\\n');
`,
    );
    const providerFreeResolution = JSON.parse(
      (await run("provider-free-module-resolution", process.execPath, ["isolation.mjs"], app))
        .stdout,
    );
    for (const name of peers) assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true);
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
      "peerDependenciesMeta",
    ])
      assert.ok(!Object.hasOwn(manifest[section] ?? {}, "js-tiktoken"));
    assert.ok(consumerRequire.resolve("zod"));
    function checkTargets(value) {
      if (typeof value === "string")
        assert.ok(fs.existsSync(path.join(sdkPath, value)), `Missing export target: ${value}`);
      else for (const child of Object.values(value)) checkTargets(child);
    }
    checkTargets(manifest.exports);
    const listing = (await run("tarball-file-list", "tar", ["-tzf", tarball])).stdout;
    report.details.inventory = assertPackageInventory(listing);
    report.details.isolation = {
      sdkPath,
      forbidden,
      nodePathCleared: true,
      packedFiles: report.details.inventory.actualCount,
    };
    report.versions.sdk = manifest.version;
    report.versions.typescript = repositoryRequire("typescript/package.json").version;
    fs.writeFileSync(path.join(app, "runtime.mjs"), runtime);
    report.details.runtime = [];
    for (const format of ["esm", "cjs"])
      report.details.runtime.push(
        JSON.parse(
          (await run(`runtime-${format}`, process.execPath, ["runtime.mjs", format], app)).stdout,
        ),
      );
    for (const ext of ["mts", "cts"]) fs.writeFileSync(path.join(app, `consumer.${ext}`), types);
    const strictTypeScriptConfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        skipLibCheck: false,
        types: [],
        lib: ["ES2023", "DOM", "ESNext.Disposable"],
      },
      files: ["consumer.mts", "consumer.cts"],
    };
    fs.writeFileSync(path.join(app, "tsconfig.json"), JSON.stringify(strictTypeScriptConfig));
    await run(
      "strict-mts-cts",
      process.execPath,
      [repositoryRequire.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
      app,
    );
    fs.writeFileSync(
      path.join(app, "tsconfig-missing-disposable.json"),
      JSON.stringify({
        ...strictTypeScriptConfig,
        compilerOptions: {
          ...strictTypeScriptConfig.compilerOptions,
          lib: ["ES2023", "DOM"],
        },
      }),
    );
    const missingDisposable = await run(
      "missing-esnext-disposable-negative-control",
      process.execPath,
      [repositoryRequire.resolve("typescript/bin/tsc"), "-p", "tsconfig-missing-disposable.json"],
      app,
      true,
    );
    assert.match(
      `${missingDisposable.stdout}\n${missingDisposable.stderr}`,
      /(?:AsyncDisposable|asyncDispose)/,
      "Removing ESNext.Disposable must expose the public async-disposal declaration requirement",
    );
    report.details.typeScriptLibraries = {
      positive: strictTypeScriptConfig.compilerOptions.lib,
      missingDisposableRejected: true,
    };
    const aiApp = path.join(consumerRoot, "ai-peer-consumer");
    fs.mkdirSync(aiApp);
    const aiFixture = path.join(root, "scripts/verification/fixtures/ai-smoke");
    for (const file of ["package.json", "package-lock.json"])
      fs.copyFileSync(path.join(aiFixture, file), path.join(aiApp, file));
    const fixtureLockHash = sha256(path.join(aiFixture, "package-lock.json"));
    const fixtureManifestHash = sha256(path.join(aiFixture, "package.json"));
    const lock = JSON.parse(fs.readFileSync(path.join(aiApp, "package-lock.json"), "utf8"));
    await run(
      "install-locked-ai-type-peers",
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--omit=optional",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--cache",
        path.join(consumerRoot, "npm-cache"),
      ],
      aiApp,
    );
    await run(
      "install-sdk-without-changing-ai-lock",
      "npm",
      [
        "install",
        tarball,
        "--no-save",
        "--ignore-scripts",
        "--omit=optional",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--cache",
        path.join(consumerRoot, "npm-cache"),
      ],
      aiApp,
    );
    assert.equal(
      sha256(path.join(aiApp, "package-lock.json")),
      fixtureLockHash,
      "Consumer lock changed",
    );
    assert.equal(
      sha256(path.join(aiApp, "package.json")),
      fixtureManifestHash,
      "Consumer manifest changed",
    );
    assert.equal(
      sha256(path.join(aiFixture, "package-lock.json")),
      fixtureLockHash,
      "Checked-in lock changed",
    );
    const lockEvidence = path.join(out, "ai-smoke-package-lock.json");
    fs.copyFileSync(path.join(aiApp, "package-lock.json"), lockEvidence);
    fs.copyFileSync(path.join(aiApp, "package.json"), path.join(out, "ai-smoke-package.json"));
    report.details.aiDependencyLock = {
      sha256: fixtureLockHash,
      evidence: lockEvidence,
      unchanged: true,
      installed: assertLockedDependencies(aiApp, lock),
      exactTree: true,
    };
    const aiRequire = createRequire(path.join(aiApp, "package.json"));
    const aiSdkPath = fs.realpathSync(path.dirname(aiRequire.resolve("@solwyn/sdk/package.json")));
    assert.ok(aiSdkPath.startsWith(`${fs.realpathSync(aiApp)}${path.sep}`));
    assert.equal(
      aiRequire("@solwyn/sdk/package.json").version,
      manifest.version,
      "AI peer consumer installed a different SDK version",
    );
    report.versions.providers.ai = aiRequire("ai/package.json").version;
    const aiTypes = `${types}\nimport {createSolwynMiddleware} from '@solwyn/sdk/ai-sdk';\nconst middleware=createSolwynMiddleware({apiKey:plane.apiKey,fetch:seam});\nvoid middleware;\n`;
    for (const ext of ["mts", "cts"])
      fs.writeFileSync(path.join(aiApp, `consumer.${ext}`), aiTypes);
    const aiConfig = JSON.parse(fs.readFileSync(path.join(app, "tsconfig.json"), "utf8"));
    aiConfig.compilerOptions.types = ["node"];
    fs.writeFileSync(path.join(aiApp, "tsconfig.json"), JSON.stringify(aiConfig));
    await run(
      "strict-all-four-entries-mts-cts",
      process.execPath,
      [repositoryRequire.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
      aiApp,
    );
    const readmeAiApp = path.join(consumerRoot, "readme-ai-consumer");
    const readmeAiContract = extractReadmeAiConsumer(
      fs.readFileSync(path.join(sdkPath, "README.md"), "utf8"),
    );
    const readmeAiPackages = resolveReadmeAiPackages(
      readmeAiContract.packageNames,
      readmeAiLockedVersions,
    );
    fs.mkdirSync(readmeAiApp);
    fs.writeFileSync(
      path.join(readmeAiApp, "package.json"),
      JSON.stringify({ name: "solwyn-readme-ai-consumer", version: "1.0.0", private: true }),
    );
    await run(
      "install-clean-readme-ai-consumer",
      "npm",
      [
        "install",
        tarball,
        ...readmeAiPackages.map(({ spec }) => spec),
        "--save-exact",
        "--ignore-scripts",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--cache",
        path.join(consumerRoot, "npm-cache"),
      ],
      readmeAiApp,
    );
    await run(
      "install-clean-readme-ai-type-tools",
      "npm",
      [
        "install",
        "@types/json-schema@7.0.15",
        "@types/node@22.15.30",
        `typescript@${report.versions.typescript}`,
        "--save-dev",
        "--save-exact",
        "--ignore-scripts",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--cache",
        path.join(consumerRoot, "npm-cache"),
      ],
      readmeAiApp,
    );
    const readmeAiRequire = createRequire(path.join(readmeAiApp, "package.json"));
    const readmeAiManifest = readmeAiRequire("./package.json");
    assert.deepEqual(Object.keys(readmeAiManifest.dependencies).sort(), [
      "@ai-sdk/openai",
      "@solwyn/sdk",
      "ai",
    ]);
    assert.deepEqual(Object.keys(readmeAiManifest.devDependencies).sort(), [
      "@types/json-schema",
      "@types/node",
      "typescript",
    ]);
    const readmeAiInstalledPackages = Object.fromEntries(
      readmeAiPackages.map(({ name, version }) => {
        const installedVersion = readmeAiRequire(`${name}/package.json`).version;
        assert.equal(installedVersion, version);
        return [name, installedVersion];
      }),
    );
    assert.equal(
      readmeAiRequire("@solwyn/sdk/package.json").version,
      manifest.version,
      "README AI consumer installed a different SDK version",
    );
    fs.writeFileSync(path.join(readmeAiApp, "readme-ai.mts"), readmeAiContract.source);
    fs.writeFileSync(
      path.join(readmeAiApp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          skipLibCheck: false,
          types: ["node"],
          lib: ["ES2023", "DOM", "ESNext.Disposable"],
        },
        files: ["readme-ai.mts"],
      }),
    );
    await run(
      "strict-clean-readme-ai-imports",
      process.execPath,
      [readmeAiRequire.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
      readmeAiApp,
    );
    report.versions.providers.ai = readmeAiInstalledPackages.ai;
    report.versions.providers.aiOpenai = readmeAiInstalledPackages["@ai-sdk/openai"];
    report.details.readmeAiTypes = {
      runtimeDependencies: Object.keys(readmeAiManifest.dependencies).sort(),
      developmentDependencies: Object.keys(readmeAiManifest.devDependencies).sort(),
      installCommand: readmeAiContract.installCommand,
      packageNames: readmeAiContract.packageNames,
      packageSpecs: readmeAiPackages.map(({ spec }) => spec),
      installedPackages: readmeAiInstalledPackages,
      sourceSha256: readmeAiContract.sourceSha256,
      strict: true,
      skipLibCheck: false,
      types: ["node"],
      lib: ["ES2023", "DOM", "ESNext.Disposable"],
    };
    fs.writeFileSync(path.join(aiApp, "artifact-identity.mjs"), entryIdentityRuntime);
    report.details.aiRuntimeIdentity = [];
    for (const format of ["esm", "cjs"]) {
      const identity = JSON.parse(
        (
          await run(
            `ai-peer-artifact-identity-${format}`,
            process.execPath,
            ["artifact-identity.mjs", format],
            aiApp,
          )
        ).stdout,
      );
      report.details.aiRuntimeIdentity.push(identity);
    }
    fs.writeFileSync(path.join(app, "run-validation.mjs"), runValidationWrapperSource());
    fs.copyFileSync(
      path.join(root, "tests/dist/fixtures/ai-sdk-harness.mjs"),
      path.join(app, "ai-sdk-harness-implementation.mjs"),
    );
    fs.writeFileSync(path.join(app, "ai-sdk-harness.mjs"), aiHarnessRunner);
    const runValidationIdentity = [];
    const aiHarnessIdentity = [];
    for (const format of ["esm", "cjs"]) {
      for (const fixture of runValidationFixtures) {
        fs.copyFileSync(path.join(root, "tests/dist/fixtures", fixture), path.join(app, fixture));
        const identityOutput = path.join(out, `package-run-validation-${format}-${fixture}.json`);
        fs.rmSync(identityOutput, { force: true });
        await run(
          `${fixture}-${format}`,
          process.execPath,
          ["run-validation.mjs", path.join(app, fixture), sdkPath, format, identityOutput],
          app,
        );
        const identityStat = fs.lstatSync(identityOutput);
        assert.ok(identityStat.isFile() && !identityStat.isSymbolicLink());
        runValidationIdentity.push(JSON.parse(fs.readFileSync(identityOutput, "utf8")));
      }
      const identityOutput = path.join(out, `package-ai-harness-${format}.json`);
      fs.rmSync(identityOutput, { force: true });
      const result = JSON.parse(
        (
          await run(
            `ai-harness-${format}`,
            process.execPath,
            aiHarnessArguments(sdkPath, format, identityOutput),
            app,
          )
        ).stdout,
      );
      assert.deepEqual(result, {
        loaded: true,
        hasWrapGenerate: true,
        hasWrapStream: true,
        hasClose: true,
        hasDispose: true,
      });
      const identityStat = fs.lstatSync(identityOutput);
      assert.ok(identityStat.isFile() && !identityStat.isSymbolicLink());
      aiHarnessIdentity.push(JSON.parse(fs.readFileSync(identityOutput, "utf8")));
    }
    // Build a separate corrupt copy and prove actual module loading rejects its missing target.
    const copied = path.join(consumerRoot, "negative-source");
    fs.mkdirSync(copied);
    await run("copy-artifact-for-negative", "tar", ["-xzf", tarball, "-C", copied]);
    const negativeManifestPath = path.join(copied, "package/package.json");
    const negativeManifest = JSON.parse(fs.readFileSync(negativeManifestPath, "utf8"));
    negativeManifest.exports["./ai-sdk"].import.default =
      "./dist/ai-sdk/missing-negative-control.js";
    fs.writeFileSync(negativeManifestPath, JSON.stringify(negativeManifest));
    const negativeTarball = path.join(consumerRoot, "missing-export.tgz");
    await run("pack-negative-copy", "tar", ["-czf", negativeTarball, "-C", copied, "package"]);
    const negativeApp = path.join(consumerRoot, "negative-consumer");
    await install(negativeApp, negativeTarball);
    fs.writeFileSync(path.join(negativeApp, "runtime.mjs"), runtime);
    const negative = await run(
      "missing-export-negative-control",
      process.execPath,
      ["runtime.mjs", "esm"],
      negativeApp,
      true,
    );
    assert.match(negative.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(negative.stderr, /missing-negative-control\.js/);
    assert.equal(sha256(tarball), report.artifact.sha256, "Reviewed artifact changed");
    report.details.artifactIdentity = {
      version: providerFreeResolution.artifactIdentity.version,
      providerFreeResolution: providerFreeResolution.artifactIdentity,
      providerFree: report.details.runtime.map(({ artifactIdentity }) => artifactIdentity),
      aiPeer: report.details.aiRuntimeIdentity,
      runValidation: runValidationIdentity,
      aiHarness: aiHarnessIdentity,
    };
    assertPackageArtifactIdentityChecks(report.details.artifactIdentity, manifest.version);
    report.details.negativeControls = {
      openaiCannotResolve: true,
      missingExportRejected: true,
      reviewedArtifactUnchanged: true,
    };
    report.checks = {
      inventory: report.details.inventory,
      runtime: report.details.runtime,
      artifactIdentity: report.details.artifactIdentity,
      negativeControls: report.details.negativeControls,
      aiDependencyLock: {
        unchanged: report.details.aiDependencyLock.unchanged,
        exactTree: report.details.aiDependencyLock.exactTree,
        sha256: report.details.aiDependencyLock.sha256,
      },
      typeScriptLibraries: report.details.typeScriptLibraries,
      readmeAiTypes: report.details.readmeAiTypes,
    };
    report.status = "pass";
  } catch (error) {
    report.details.error = error.stack ?? String(error);
    report.failure ??= failureFor(error);
    throw error;
  } finally {
    finalizeReport(report, resultFile);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPackageConsumers(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
