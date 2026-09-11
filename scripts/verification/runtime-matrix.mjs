import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  allInstalledEntries,
  assertRuntimeChecks,
  installedArtifactIdentitySource,
  runValidationFixtures,
  runValidationWrapperSource,
} from "./artifact-identity.mjs";
import {
  command,
  commandResult,
  environmentError,
  installConsumer,
  runProbe,
} from "./runtime-support.mjs";
import { repositoryRoot as root } from "./support.mjs";

async function runtimeMatrix({ tarball, out }, report, evidence) {
  let binaries;
  try {
    binaries = process.env.SOLWYN_VERIFICATION_NODE_BINARIES
      ? JSON.parse(process.env.SOLWYN_VERIFICATION_NODE_BINARIES)
      : [process.execPath];
    assert.ok(Array.isArray(binaries) && binaries.length > 0);
    assert.equal(new Set(binaries).size, binaries.length);
    for (const binary of binaries) assert.ok(typeof binary === "string" && path.isAbsolute(binary));
  } catch (error) {
    throw environmentError(
      "Configured Node binaries must be unique absolute executable paths",
      error,
    );
  }
  report.versions.runtimes = [];
  report.checks.runtimes = report.versions.runtimes;
  for (const binary of binaries) {
    const version = (
      await command(binary, ["--version"], out, 5000, evidence, { prerequisite: true })
    ).trim();
    if (!/^v\d+\.\d+\.\d+$/.test(version))
      throw environmentError("Configured Node executable did not return a Node version");
    report.versions.runtimes.push({ binary, version });
  }
  const { app, sdkRoot } = await installConsumer(tarball, "matrix-provider-free", [], evidence);
  const { app: nativeApp, sdkRoot: nativeSdkRoot } = await installConsumer(
    tarball,
    "matrix-native",
    [
      "@anthropic-ai/sdk@0.123.0",
      "@aws-sdk/client-bedrock@3.1124.0",
      "@aws-sdk/client-s3@3.1124.0",
    ],
    evidence,
  );
  report.versions.anthropic = JSON.parse(
    fs.readFileSync(path.join(nativeApp, "node_modules/@anthropic-ai/sdk/package.json"), "utf8"),
  ).version;
  const installedManifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
  const nativeInstalledManifest = JSON.parse(
    fs.readFileSync(path.join(nativeSdkRoot, "package.json"), "utf8"),
  );
  assert.equal(nativeInstalledManifest.version, installedManifest.version);
  report.versions.sdk = installedManifest.version;
  report.versions.aws = {};
  for (const name of ["client-bedrock", "client-s3"]) {
    const version = JSON.parse(
      fs.readFileSync(path.join(nativeApp, "node_modules/@aws-sdk", name, "package.json"), "utf8"),
    ).version;
    assert.equal(version, "3.1124.0");
    report.versions.aws[name] = version;
  }
  report.details.consumers = { providerFree: app, native: nativeApp };

  const runtime = `import assert from 'node:assert/strict';
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
const plane=new testing.FakeControlPlane();
let dispatched=0;
const provider={chat:{completions:{create(){dispatched++;return {usage:{prompt_tokens:2,completion_tokens:3}};}}}};
const client=new sdk.Solwyn(provider,{apiKey:plane.apiKey,apiUrl:plane.apiUrl,fetch:plane.fetch,leaseEnabled:false,logger:sdk.noopLogger,reportUntrackedSurfaces:false});
await node.run('consumer-review',async()=>{await client.chat.completions.create({model:'gpt-review'});});
await client.close();
const middleware=ai.createSolwynMiddleware({apiKey:plane.apiKey,apiUrl:plane.apiUrl,fetch:plane.fetch,leaseEnabled:false,logger:sdk.noopLogger});
await middleware.close();
const health=await (await plane.fetch(plane.apiUrl+'/health')).json();
assert.equal(dispatched,1);assert.equal(plane.checks.length,1);assert.equal(plane.confirms.length,1);assert.equal(plane.ingested.length,1);
assert.equal(typeof plane.checks[0].agent_run_id,'string');assert.equal(plane.ingested[0].agent_run_name,'consumer-review');assert.equal(health.status,'ok');
process.stdout.write(JSON.stringify({format,dispatched,check:plane.checks.length,confirm:plane.confirms.length,ingest:plane.ingested.length,attributed:true,aiRuntimeWithoutPeer:true,artifactIdentity})+'\\n');
`;
  fs.writeFileSync(path.join(app, "runtime.mjs"), runtime);

  const nativeScript = path.join(nativeApp, "runtime.mjs");
  fs.writeFileSync(
    nativeScript,
    `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const req=createRequire(import.meta.url);
const format=process.argv[2];
const load=name=>format==='cjs'?req(name):import(name);
const sdk=await load('@solwyn/sdk');
const testing=await load('@solwyn/sdk/testing');
let artifactIdentity;
${installedArtifactIdentitySource(
  [
    { specifier: "@solwyn/sdk", binding: "sdk", version: true },
    { specifier: "@solwyn/sdk/testing", binding: "testing" },
  ],
  "artifactIdentity",
  "format",
)}
const {Solwyn,noopLogger}=sdk;
const {FakeControlPlane}=testing;
const native=await load('@anthropic-ai/sdk');
const Anthropic=native.default??native;
let dispatches=0;
const plane=new FakeControlPlane();
const raw=new Anthropic({apiKey:'synthetic',maxRetries:0,fetch:async()=>{
  dispatches++;
  return new Response(JSON.stringify({id:'msg_structural',type:'message',role:'assistant',model:'claude-review',content:[],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:2,output_tokens:3}}),{headers:{'content-type':'application/json'}});
}});
const client=new Solwyn(raw,{apiKey:plane.apiKey,apiUrl:plane.apiUrl,fetch:plane.fetch,leaseEnabled:false,reportUntrackedSurfaces:false,logger:noopLogger});
const result=client.messages.create({model:'claude-review',messages:[],max_tokens:3});
assert.equal(typeof result.then,'function');
assert.equal('withResponse' in result,false);
assert.equal('asResponse' in result,false);
const response=await result;
assert.equal(response.usage.output_tokens,3);
await client.close();
assert.equal(dispatches,1);
assert.equal(plane.confirms.length,1);
assert.equal(plane.ingested.length,1);
process.stdout.write(JSON.stringify({format,dispatches,confirms:plane.confirms.length,ingested:plane.ingested.length,ordinaryPromise:true,artifactIdentity})+'\\n');
`,
  );
  const foreignAwsScript = path.join(nativeApp, "foreign-aws.mjs");
  fs.writeFileSync(
    foreignAwsScript,
    `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const req=createRequire(import.meta.url);
const format=process.argv[2];
const load=format=>format==='esm'?import('@solwyn/sdk'):req('@solwyn/sdk');
const sdk=await load(format);
const opposite=await load(format==='esm'?'cjs':'esm');
let artifactIdentity;
${installedArtifactIdentitySource(
  [{ specifier: "@solwyn/sdk", binding: "sdk", version: true }],
  "artifactIdentity",
  "format",
)}
const {BedrockClient}=req('@aws-sdk/client-bedrock');
const {S3Client}=req('@aws-sdk/client-s3');
class InstrumentedBedrockControlClient extends BedrockClient {}
class InstrumentedS3Client extends S3Client {}
const credentials={accessKeyId:'synthetic',secretAccessKey:'synthetic'};
let requests=0;
const noNetwork=async()=>{requests++;throw new Error('Unexpected network request');};
globalThis.fetch=noNetwork;
const results=[];
for(const [family,Client] of [
  ['bedrock-control',BedrockClient],
  ['bedrock-control-subclass',InstrumentedBedrockControlClient],
  ['s3',S3Client],
  ['s3-subclass',InstrumentedS3Client],
]){
  const raw=new Client({region:'us-east-1',credentials});
  try{
    assert.throws(()=>new sdk.Solwyn(raw,{
      apiKey:'sk_proj_'+'0'.repeat(64),logger:sdk.noopLogger,reportUntrackedSurfaces:false,fetch:noNetwork,
    }),error=>error instanceof sdk.ConfigurationError && error instanceof opposite.ConfigurationError && error.field==='provider',format+' '+family+' must fail automatic detection synchronously');
    results.push({format,family,rejected:true});
  }finally{raw.destroy();}
}
assert.equal(requests,0);
process.stdout.write(JSON.stringify({results,requests,network:'none; constructors and synchronous detection only',artifactIdentity}));
`,
  );
  const runValidationScript = path.join(app, "run-validation.mjs");
  fs.writeFileSync(runValidationScript, runValidationWrapperSource());
  const results = [];
  report.checks.cells = [];
  report.details.cells = results;
  report.details.foreignAwsControls = [];
  let cellIndex = 0;
  for (const { binary, version } of report.versions.runtimes) {
    for (const format of ["esm", "cjs"]) {
      const cases = [
        ["provider-free-runtime", [path.join(app, "runtime.mjs"), format]],
        [
          "mixed-format-enforcement-identity",
          [
            runValidationScript,
            path.join(root, "tests/dist/fixtures", runValidationFixtures[0]),
            sdkRoot,
            format,
          ],
        ],
        ["native-anthropic-promise", [nativeScript, format]],
        ["native-foreign-aws", [foreignAwsScript, format]],
        [
          "post-remediation-errors",
          [
            runValidationScript,
            path.join(root, "tests/dist/fixtures", runValidationFixtures[1]),
            sdkRoot,
            format,
          ],
        ],
      ];
      for (const [name, args] of cases) {
        const usesIdentitySidecar =
          name === "mixed-format-enforcement-identity" || name === "post-remediation-errors";
        const identityOutput = usesIdentitySidecar
          ? path.join(out, `runtime-matrix-identity-${cellIndex}.json`)
          : undefined;
        if (identityOutput !== undefined) fs.rmSync(identityOutput, { force: true });
        const childArgs = identityOutput === undefined ? args : [...args, identityOutput];
        const result = await commandResult(
          binary,
          childArgs,
          name.startsWith("native-") ? nativeApp : app,
          30000,
          evidence,
        );
        results.push({
          binary,
          version,
          name,
          format,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        fs.writeFileSync(
          path.join(out, "runtime-matrix-results.json"),
          JSON.stringify(results, null, 2),
        );
        assert.equal(
          result.status,
          0,
          `${version} ${name} ${format}: inspect runtime-matrix-results.json`,
        );
        const parsed = JSON.parse(result.stdout);
        let artifactIdentity;
        if (identityOutput === undefined) {
          artifactIdentity = parsed.artifactIdentity;
          delete parsed.artifactIdentity;
        } else {
          const identityStat = fs.lstatSync(identityOutput);
          assert.ok(identityStat.isFile() && !identityStat.isSymbolicLink());
          const identityEvidence = JSON.parse(fs.readFileSync(identityOutput, "utf8"));
          assert.equal(identityEvidence.fixture, path.basename(args[1]));
          artifactIdentity = identityEvidence.artifactIdentity;
        }
        results.at(-1).result = parsed;
        report.checks.cells.push({
          binary,
          version,
          name,
          format,
          status: result.status,
          artifactIdentity,
          result: parsed,
        });
        if (name === "post-remediation-errors") {
          assert.deepEqual(parsed, { families: 11, denied: 8, stopped: 8, middlewareDenied: 2 });
        } else if (name === "native-foreign-aws") {
          assert.equal(parsed.requests, 0);
          assert.deepEqual(parsed.results, [
            { format, family: "bedrock-control", rejected: true },
            { format, family: "bedrock-control-subclass", rejected: true },
            { format, family: "s3", rejected: true },
            { format, family: "s3-subclass", rejected: true },
          ]);
          report.details.foreignAwsControls.push(
            ...parsed.results.map((control) => ({ binary, version, ...control })),
          );
        }
        cellIndex++;
      }
    }
  }
  assert.equal(report.details.foreignAwsControls.length, binaries.length * 8);
  const canonicalIdentity = report.checks.cells.find(
    ({ name, format }) => name === "provider-free-runtime" && format === "esm",
  )?.artifactIdentity;
  assert.ok(canonicalIdentity, "Runtime matrix did not observe a canonical package identity");
  report.checks.artifactIdentity = canonicalIdentity;
  assertRuntimeChecks(report.checks, installedManifest.version);
  process.stdout.write(
    `${results.length} installed runtime controls passed on ${binaries.length} Node versions.\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runProbe("runtime-matrix", runtimeMatrix);
}
