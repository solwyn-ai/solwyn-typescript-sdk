import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("installed consumer verification gate", () => {
  it.each([
    "pass",
    "legacy-only",
    "unknown-schema",
    "missing-checks",
    "checks-only",
    "ai-missing-upstream-diagnostic",
    "ai-upstream-wrong-version",
    "ai-upstream-wrong-format",
    "ai-upstream-wrong-status",
    "ai-upstream-success-status",
    "ai-upstream-missing-exit-status",
    "ai-upstream-runner-error",
    "ai-upstream-wrong-identity",
    "ai-upstream-diagnostic-version-mismatch",
    "ai-upstream-masks-sdk",
    "ai-upstream-counted-as-cell",
    "bundle-mutated-dispatch",
    "bundle-replaced-label",
    "bundle-missing-label",
    "bundle-wrong-format",
    "bundle-wrong-annotation-mode",
    "bundle-wrong-registration",
    "bundle-wrong-check",
    "bundle-wrong-confirm",
    "bundle-wrong-ingest",
    "google-mutated-outcome",
    "google-missing-control",
    "google-duplicate-control",
    "google-provider-requests",
    "google-observed-signal",
    "google-abort-transport",
    "google-pending-timers",
    "google-ref-timers",
    "google-after-native-deadline",
    "google-native-abort",
    "google-stream-reader",
    "google-gc-promise",
    "google-gc-open",
    "google-gc-surrenders",
    "google-gc-deadline",
    "google-gc-grants",
    "google-gc-spent",
    "browser-cleanup-incomplete",
    "browser-output-truncated",
    "browser-settlement",
    "mixed-case-node-path",
    "unresponsive-probe",
    "skipped",
    "missing",
    "nonzero",
    "empty-evidence",
    "missing-compiler",
    "wrong-artifact",
    "missing-cell",
    "missing-provider",
    "package-missing-exact-tree",
    "package-false-exact-tree",
    "package-missing-identity",
    "package-wrong-identity",
    "package-missing-disposable-control",
    "package-wrong-readme-ai-types",
    "empty-package-consumers",
    "empty-native-type-consumer",
    "empty-bundle-proofs",
    "empty-browser-proof",
    "empty-runtime-matrix",
    "empty-google-native-compat",
    "runtime-missing-aws-cells",
    "runtime-missing-error-cells",
    "runtime-wrong-aws-version",
    "runtime-aws-request",
    "runtime-aws-not-rejected",
    "runtime-wrong-error-count",
    "runtime-missing-identity",
    "runtime-wrong-identity",
    "native-missing-responses",
    "native-wrong-responses-format",
    "native-missing-primary-consumer",
  ])("accepts only complete successful child evidence: %s", (scenario) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "verification-pack-driver-"));
    temporary.push(scratch);
    const scripts = path.join(scratch, "repo/scripts/verification");
    const out = path.join(scratch, "output");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(out);
    copyFileSync(path.join(repository, "README.md"), path.join(scratch, "repo/README.md"));
    const tarball = path.join(scratch, "artifact.tgz");
    writeFileSync(tarball, "unchanged artifact bytes");
    // Exercise the actual driver; stand-in child programs model its process boundary only.
    for (const file of [
      "run.mjs",
      "process.mjs",
      "support.mjs",
      "artifact-identity.mjs",
      "readme-consumer.mjs",
    ])
      copyFileSync(path.join(repository, "scripts/verification", file), path.join(scripts, file));
    const probes = [
      "package-consumers",
      "native-type-consumer",
      "ai-type-consumer",
      "bundle-proofs",
      "browser-proof",
      "runtime-matrix",
      "google-native-compat",
    ];
    for (const probe of probes) {
      const target = scenario.startsWith("package-")
        ? "package-consumers"
        : scenario.startsWith("native-")
          ? "native-type-consumer"
          : scenario.startsWith("runtime-")
            ? "runtime-matrix"
            : scenario.startsWith("bundle-")
              ? "bundle-proofs"
              : scenario.startsWith("google-")
                ? "google-native-compat"
                : scenario.startsWith("browser-")
                  ? "browser-proof"
                  : scenario.startsWith("empty-") && scenario !== "empty-evidence"
                    ? scenario.slice(6)
                    : "ai-type-consumer";
      const selected = probe === target;
      const status = selected && scenario === "skipped" ? "skipped" : "pass";
      const missing = selected && scenario === "missing";
      writeFileSync(
        path.join(scripts, `${probe}.mjs`),
        `
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractReadmeAiConsumer,readmeAiLockedVersions,resolveReadmeAiPackages} from './readme-consumer.mjs';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
if(Object.keys(process.env).some(key=>key.toUpperCase()==='NODE_PATH'))process.exit(4);
const out=process.argv[process.argv.indexOf('--out')+1];
const artifact=process.argv[process.argv.indexOf('--tarball')+1];
const hash=value=>createHash('sha256').update(value).digest('hex');
const probe=${JSON.stringify(probe)};
const readmeAiContract=extractReadmeAiConsumer(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../README.md'),'utf8'));
const readmeAiPackages=resolveReadmeAiPackages(readmeAiContract.packageNames,readmeAiLockedVersions);
const compiler={floor:'5.8.3',current:'6.0.3'};
const compilerCells=Object.entries(compiler).flatMap(([label,version])=>['esm','cjs'].map(format=>({compiler:{label,version},format,status:'pass',strict:true,skipLibCheck:false,files:format==='esm'?['consumer.mts','responses-consumer.mts']:['consumer.cts','responses-consumer.cts'],command:{status:0},baseline:{status:0},sdk:{status:0},inference:{status:0}})));
const sdkVersion='7.6.5';
const allSdkEntries=['@solwyn/sdk','@solwyn/sdk/node','@solwyn/sdk/testing','@solwyn/sdk/ai-sdk'];
const artifactIdentity=(format='esm',entries=allSdkEntries,consumer='provider-free')=>{
  const consumerRealpath=path.join(out,'observed',consumer);
  const packageRoot=path.join(consumerRealpath,'node_modules/@solwyn/sdk');
  return {format,version:sdkVersion,manifestWithinConsumer:true,consumerRealpath,manifestRealpath:path.join(packageRoot,'package.json'),entries,entryRealpaths:Object.fromEntries(entries.map((entry,index)=>[entry,path.join(packageRoot,'dist',String(index)+(format==='esm'?'.js':'.cjs'))])),versions:Object.fromEntries(entries.filter(entry=>entry==='@solwyn/sdk'||entry==='@solwyn/sdk/node').map(entry=>[entry,sdkVersion]))};
};
const runtimeEntries={
  'provider-free-runtime':allSdkEntries,
  'mixed-format-enforcement-identity':allSdkEntries,
  'native-anthropic-promise':['@solwyn/sdk','@solwyn/sdk/testing'],
  'native-foreign-aws':['@solwyn/sdk'],
  'post-remediation-errors':allSdkEntries,
};
const runtimeResult=(name,format)=>{
  if(name==='provider-free-runtime')return {format,dispatched:1,check:1,confirm:1,ingest:1,attributed:true,aiRuntimeWithoutPeer:true};
  if(name==='mixed-format-enforcement-identity')return {firstFormat:format,denied:6,dispatches:0,checks:6,ingested:6,sharedBrands:true};
  if(name==='native-anthropic-promise')return {format,dispatches:1,confirms:1,ingested:1,ordinaryPromise:true};
  if(name==='native-foreign-aws')return {results:['bedrock-control','bedrock-control-subclass','s3','s3-subclass'].map(family=>({format,family,rejected:true})),requests:0,network:'none; constructors and synchronous detection only'};
  if(name==='post-remediation-errors')return {families:11,denied:8,stopped:8,middlewareDenied:2};
  throw new Error('Unknown runtime cell '+name);
};
const versions={node:process.version};
const details={};
if(probe==='package-consumers'){
  Object.assign(versions,{sdk:sdkVersion,typescript:'6.0.3',providers:{ai:'7.0.14',aiOpenai:'4.0.65'}});
  fs.writeFileSync(path.join(out,'ai-smoke-package-lock.json'),'locked dependencies');
  const fixtures=['package-identity-remediation.mjs','post-remediation-errors.mjs'];
  Object.assign(details,{artifactIdentity:{version:sdkVersion,providerFreeResolution:artifactIdentity('esm'),providerFree:['esm','cjs'].map(format=>artifactIdentity(format)),aiPeer:['esm','cjs'].map(format=>artifactIdentity(format,allSdkEntries,'ai-peer')),runValidation:['esm','cjs'].flatMap(format=>fixtures.map(fixture=>({fixture,artifactIdentity:artifactIdentity(format)}))),aiHarness:['esm','cjs'].map(format=>({format,artifactIdentity:artifactIdentity(format)}))},inventory:{verified:true,actualCount:88},runtime:['esm','cjs'].map(format=>({format,dispatches:3,checks:3,confirms:3,ingested:3,aiBuffered:true,aiStreaming:true,artifactIdentity:artifactIdentity(format)})),negativeControls:{openaiCannotResolve:true,missingExportRejected:true,reviewedArtifactUnchanged:true},aiDependencyLock:{unchanged:true,exactTree:true,sha256:hash('locked dependencies')},typeScriptLibraries:{positive:['ES2023','DOM','ESNext.Disposable'],missingDisposableRejected:true},readmeAiTypes:{runtimeDependencies:['@solwyn/sdk',...readmeAiContract.packageNames].sort(),developmentDependencies:['@types/json-schema','@types/node','typescript'],installCommand:readmeAiContract.installCommand,packageNames:readmeAiContract.packageNames,packageSpecs:readmeAiPackages.map(({spec})=>spec),installedPackages:Object.fromEntries(readmeAiPackages.map(({name,version})=>[name,version])),sourceSha256:readmeAiContract.sourceSha256,strict:true,skipLibCheck:false,types:['node'],lib:['ES2023','DOM','ESNext.Disposable']}});
}else if(probe==='native-type-consumer'||probe==='ai-type-consumer'){
  Object.assign(versions,{typescript:compiler,openai:'6.45.0',anthropic:'0.123.0',ai:'7.0.14',typesJsonSchema:'7.0.15',typesNode:'22.15.30',zod:'4.4.3'});
  Object.assign(details,{strict:true,skipLibCheck:false,cells:compilerCells});
  if(probe==='ai-type-consumer'){versions.typescript={...compiler,diagnostic:'5.7.3'};details.upstreamBaselineDiagnostic={compiler:{label:'diagnostic',version:'5.7.3'},format:'cjs',expected:'upstream-invalid',status:'upstream-invalid',command:{status:2,signal:null,timedOut:false,stdout:'error TS1479: upstream is ESM',stderr:''}};}
}else if(probe==='bundle-proofs'){
  versions.esbuild='0.27.7';
  fs.writeFileSync(path.join(out,'edge-browser-bundle.js'),'bundle evidence');
  Object.assign(details,{nodeControls:['esm','cjs'].flatMap(format=>['node-reexport','node-bare-import','node-run-used','core-explicit-close'].flatMap(kind=>[false,true].map(ignoreAnnotations=>({label:format+'-'+kind+'-'+(ignoreAnnotations?'ignore-annotations':'default'),format,ignoreAnnotations,status:0,result:{dispatched:1,registration:kind==='core-explicit-close'?'undefined':'function',checks:1,confirms:1,ingested:1},warnings:[]})))),edgeVm:{ok:true,providerCalls:2,checks:4,confirms:4,transmittedEvents:4,uniqueCalls:4,ingested:4,legacyDedupCollisions:0,unexpectedFetch:0,ambientRunAbsent:true,nodeGlobalAbsent:true,bufferAbsent:true,coreClosed:{checks:2,confirms:2,ingested:2},warnings:[]},bundleSha256:hash('bundle evidence'),bundlePath:path.join(out,'edge-browser-bundle.js'),externalImports:[]});
}else if(probe==='browser-proof'){
  versions.browser='Chromium 152.0.0';
  Object.assign(details,{result:{ok:true,providerCalls:2,checks:4,confirms:4,transmittedEvents:4,uniqueCalls:4,ingested:4,legacyDedupCollisions:0,unexpectedFetch:0,ambientRunAbsent:true,nodeGlobalAbsent:true,bufferAbsent:true,coreClosed:{checks:2,confirms:2,ingested:2},warnings:[]},execution:{browser:process.execPath,exit:{code:0,signal:null}},supervisorCleanup:{method:'owned-supervisor-group',attempted:true,completed:null,cleanupTimedOut:false,error:null,detached:false},stderr:{limitBytes:1048576,receivedBytes:0,retainedBytes:0,truncated:false},bundleSha256:hash('bundle evidence')});
}else if(probe==='runtime-matrix'){
  Object.assign(versions,{sdk:sdkVersion,anthropic:'0.123.0',aws:{'client-bedrock':'3.1124.0','client-s3':'3.1124.0'},runtimes:[{binary:process.execPath,version:process.version}]});
  details.runtimes=[{binary:process.execPath,version:process.version}];
  details.artifactIdentity=artifactIdentity('esm');
  details.cells=['esm','cjs'].flatMap(format=>['provider-free-runtime','mixed-format-enforcement-identity','native-anthropic-promise','native-foreign-aws','post-remediation-errors'].map(name=>({name,format,binary:process.execPath,version:process.version,status:0,artifactIdentity:artifactIdentity(format,runtimeEntries[name],name.startsWith('native-')?'native':'provider-free'),result:runtimeResult(name,format)})));
}else{
  versions.google=['0.3.1','2.20.0'];
  details.noLiveCalls=true;
  details.controls=[['0.3.1','native'],['2.20.0','native'],['2.20.0','unknown']].flatMap(([version,metadata])=>['buffered','embeddings','stream-return','deadline','caller-abort'].map(scenario=>({version,metadata,scenario,providerRequests:1,observedSignal:true,outcome:['deadline','caller-abort'].includes(scenario)?'rejected':'fulfilled',transportAborted:['deadline','caller-abort'].includes(scenario),pendingProviderTimersAfterClose:['deadline','caller-abort'].includes(scenario)||version==='2.20.0'&&metadata==='native'?0:1,referencedProviderTimersAfterClose:['deadline','caller-abort'].includes(scenario)||version==='2.20.0'?0:1,pendingProviderTimersAfterNativeDeadline:0,nativeAbortedAtCallerAbort:scenario==='caller-abort'?version!=='0.3.1':null,streamReaderReleased:scenario==='stream-return'?true:null})));
  details.controls.push({version:'2.20.0',metadata:'native',scenario:'completed-run-gc',retainedSettledPromise:true,clientStillOpenAtRetirement:true,leaseSurrendersBeforeClose:1,providerDeadlineSeconds:600,leaseGrants:1,spentTokens:0});
}
const report={schemaVersion:1,probe,status:${JSON.stringify(status)},artifact:{path:fs.realpathSync(artifact),sha256:hash(fs.readFileSync(artifact))},versions,checks:details,details:{},failure:null,cleanup:{keepRequested:false,roots:[],failure:null}};
report.details=structuredClone(report.checks);
if(${scenario === "checks-only"})report.details={};
if(${selected}){
  const scenario=${JSON.stringify(scenario)};
  if(scenario==='legacy-only'){delete report.schemaVersion;delete report.checks;}
  if(scenario==='unknown-schema')report.schemaVersion=2;
  if(scenario==='missing-checks')delete report.checks;
  if(scenario==='ai-missing-upstream-diagnostic')delete report.checks.upstreamBaselineDiagnostic;
  if(scenario==='ai-upstream-wrong-version')report.checks.upstreamBaselineDiagnostic.compiler.version='5.8.3';
  if(scenario==='ai-upstream-wrong-format')report.checks.upstreamBaselineDiagnostic.format='esm';
  if(scenario==='ai-upstream-wrong-status')report.checks.upstreamBaselineDiagnostic.status='unexpected-result';
  if(scenario==='ai-upstream-success-status')report.checks.upstreamBaselineDiagnostic.command.status=0;
  if(scenario==='ai-upstream-missing-exit-status')report.checks.upstreamBaselineDiagnostic.command.status=null;
  if(scenario==='ai-upstream-runner-error')report.checks.upstreamBaselineDiagnostic.command.error={code:'ENOENT'};
  if(scenario==='ai-upstream-wrong-identity')report.checks.upstreamBaselineDiagnostic.command.stdout='error TS2345: wrong diagnostic';
  if(scenario==='ai-upstream-diagnostic-version-mismatch')report.versions.typescript.diagnostic='5.7.2';
  if(scenario==='ai-upstream-masks-sdk')report.checks.cells[0].sdk.status=1;
  if(scenario==='ai-upstream-counted-as-cell')report.checks.cells.push(report.checks.upstreamBaselineDiagnostic);
  if(scenario==='bundle-mutated-dispatch')report.checks.nodeControls[0].result.dispatched=0;
  if(scenario==='google-mutated-outcome')report.checks.controls[0].outcome='rejected';
  if(scenario==='bundle-replaced-label')report.checks.nodeControls[0].label='unreviewed-control';
  if(scenario==='bundle-missing-label')report.checks.nodeControls.pop();
  if(scenario==='bundle-wrong-format')report.checks.nodeControls[0].format='cjs';
  if(scenario==='bundle-wrong-annotation-mode')report.checks.nodeControls[0].ignoreAnnotations=true;
  if(scenario==='bundle-wrong-registration')report.checks.nodeControls[0].result.registration='undefined';
  if(scenario==='bundle-wrong-check')report.checks.nodeControls[0].result.checks=0;
  if(scenario==='bundle-wrong-confirm')report.checks.nodeControls[0].result.confirms=0;
  if(scenario==='bundle-wrong-ingest')report.checks.nodeControls[0].result.ingested=0;
  if(scenario==='google-missing-control')report.checks.controls.pop();
  if(scenario==='google-duplicate-control')report.checks.controls[0]=report.checks.controls[1];
  if(scenario==='google-provider-requests')report.checks.controls[0].providerRequests=0;
  if(scenario==='google-observed-signal')report.checks.controls[0].observedSignal=false;
  if(scenario==='google-abort-transport')report.checks.controls.find(cell=>cell.scenario==='deadline').transportAborted=false;
  if(scenario==='google-pending-timers')report.checks.controls[0].pendingProviderTimersAfterClose=0;
  if(scenario==='google-ref-timers')report.checks.controls[0].referencedProviderTimersAfterClose=0;
  if(scenario==='google-after-native-deadline')report.checks.controls[0].pendingProviderTimersAfterNativeDeadline=1;
  if(scenario==='google-native-abort')report.checks.controls.find(cell=>cell.scenario==='caller-abort').nativeAbortedAtCallerAbort=true;
  if(scenario==='google-stream-reader')report.checks.controls.find(cell=>cell.scenario==='stream-return').streamReaderReleased=false;
  if(scenario==='google-gc-promise')report.checks.controls.at(-1).retainedSettledPromise=false;
  if(scenario==='google-gc-open')report.checks.controls.at(-1).clientStillOpenAtRetirement=false;
  if(scenario==='google-gc-surrenders')report.checks.controls.at(-1).leaseSurrendersBeforeClose=0;
  if(scenario==='google-gc-deadline')report.checks.controls.at(-1).providerDeadlineSeconds=0;
  if(scenario==='google-gc-grants')report.checks.controls.at(-1).leaseGrants=0;
  if(scenario==='google-gc-spent')report.checks.controls.at(-1).spentTokens=1;
  if(scenario==='browser-cleanup-incomplete')report.checks.supervisorCleanup.cleanupTimedOut=true;
  if(scenario==='browser-output-truncated')report.checks.stderr.truncated=true;
  if(scenario==='browser-settlement')report.checks.result.confirms=0;
  if(scenario.startsWith('empty-')){report.checks={};report.versions={};}
  if(scenario==='missing-compiler')delete report.versions.typescript;
  if(scenario==='missing-provider')delete report.versions.ai;
  if(scenario==='package-missing-exact-tree')delete report.checks.aiDependencyLock.exactTree;
  if(scenario==='package-false-exact-tree')report.checks.aiDependencyLock.exactTree=false;
  if(scenario==='package-missing-identity')delete report.checks.artifactIdentity;
  if(scenario==='package-wrong-identity')report.checks.artifactIdentity.aiPeer[0].version='7.6.4';
  if(scenario==='package-missing-disposable-control')report.checks.typeScriptLibraries.missingDisposableRejected=false;
  if(scenario==='package-wrong-readme-ai-types')report.checks.readmeAiTypes.sourceSha256='missing';
  if(scenario==='wrong-artifact')report.artifact.sha256='0'.repeat(64);
  if(scenario==='missing-cell')report.checks.cells.pop();
  if(scenario==='runtime-missing-aws-cells')report.checks.cells=report.checks.cells.filter(cell=>cell.name!=='native-foreign-aws');
  if(scenario==='runtime-missing-error-cells')report.checks.cells=report.checks.cells.filter(cell=>cell.name!=='post-remediation-errors');
  if(scenario==='runtime-wrong-aws-version')report.versions.aws['client-s3']='3.1000.0';
  if(scenario==='runtime-aws-request')report.checks.cells.find(cell=>cell.name==='native-foreign-aws').result.requests=1;
  if(scenario==='runtime-aws-not-rejected')report.checks.cells.find(cell=>cell.name==='native-foreign-aws').result.results[0].rejected=false;
  if(scenario==='runtime-wrong-error-count')report.checks.cells.find(cell=>cell.name==='post-remediation-errors').result.families=10;
  if(scenario==='runtime-missing-identity')delete report.checks.artifactIdentity;
  if(scenario==='runtime-wrong-identity')report.checks.cells[0].artifactIdentity.version='7.6.4';
  if(scenario==='native-missing-responses')report.checks.cells[0].files=['consumer.mts'];
  if(scenario==='native-wrong-responses-format')report.checks.cells[0].files=['consumer.mts','responses-consumer.cts'];
  if(scenario==='native-missing-primary-consumer')report.checks.cells[0].files=['responses-consumer.mts'];
}
if(!${missing})fs.writeFileSync(path.join(out,${JSON.stringify(`${probe}.json`)}),JSON.stringify(report));
if(${probe === "google-native-compat"} && typeof globalThis.gc!=='function')process.exit(3);
if(${selected && scenario === "unresponsive-probe"}){process.on('SIGTERM',()=>{});process.stdout.write('probe-started\\n');setTimeout(()=>process.exit(0),2500);}else process.exit(${selected && scenario === "nonzero" ? 2 : 0});
}
`,
      );
    }
    // An old successful result must not hide a child which exits without writing evidence.
    writeFileSync(
      path.join(out, "ai-type-consumer.json"),
      JSON.stringify({ probe: "ai-type-consumer", status: "pass", versions: {}, details: {} }),
    );
    const timeoutPreload = path.join(scratch, "timeout-preload.mjs");
    writeFileSync(
      timeoutPreload,
      "const original=globalThis.setTimeout;globalThis.setTimeout=(callback,delay,...args)=>original(callback,delay===900000?200:delay,...args);",
    );
    const started = Date.now();
    const child = spawnSync(
      process.execPath,
      [
        ...(scenario === "unresponsive-probe"
          ? ["--import", pathToFileURL(timeoutPreload).href]
          : []),
        path.join(scripts, "run.mjs"),
        "--",
        "--tarball",
        tarball,
        "--out",
        out,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          SOLWYN_VERIFICATION_NODE_BINARIES: JSON.stringify([process.execPath]),
          ...(scenario === "mixed-case-node-path"
            ? { Node_Path: "/untrusted/mixed", nOdE_pAtH: "/untrusted/duplicate" }
            : {}),
        },
      },
    );
    const shouldPass =
      scenario === "pass" || scenario === "mixed-case-node-path" || scenario === "checks-only";
    const result = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8"));
    const failedProbe = result.details.probes.find(
      (probe: { status: string }) => probe.status === "fail",
    );
    expect(
      child.status,
      `${child.stdout}\n${child.stderr}\n${JSON.stringify(failedProbe, null, 2)}`,
    ).toBe(shouldPass ? 0 : 1);
    expect(result.status).toBe(shouldPass ? "pass" : "fail");
    expect(result.details.probes).toHaveLength(7);
    if (scenario === "unresponsive-probe") {
      expect(Date.now() - started).toBeLessThan(1800);
      const failed = result.details.probes.find(
        (probe: { probe: string }) => probe.probe === "ai-type-consumer",
      );
      expect(failed.command.timedOut).toBe(true);
      expect(failed.command.elapsedMs).toBeLessThan(1000);
      expect(failed.stdout).toContain("probe-started");
      expect(failed.failure.artifactFailure).toBe(false);
    }
    expect(result.details.probes.at(-1).status).toBe(
      scenario === "empty-google-native-compat" || scenario.startsWith("google-") ? "fail" : "pass",
    );
    expect(readFileSync(tarball, "utf8")).toBe("unchanged artifact bytes");
    expect(result.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
