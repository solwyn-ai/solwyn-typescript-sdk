import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { assertEdgeResult, commandResult, installConsumer, runProbe } from "./runtime-support.mjs";
import { sha256 } from "./support.mjs";

export function assertBundleChecks(checks) {
  const expected = ["esm", "cjs"].flatMap((format) =>
    ["node-reexport", "node-bare-import", "node-run-used", "core-explicit-close"].flatMap((name) =>
      [false, true].map((ignoreAnnotations) => ({
        label: `${format}-${name}-${ignoreAnnotations ? "ignore-annotations" : "default"}`,
        format,
        ignoreAnnotations,
        status: 0,
        result: {
          dispatched: 1,
          registration: name === "core-explicit-close" ? "undefined" : "function",
          checks: 1,
          confirms: 1,
          ingested: 1,
        },
        warnings: [],
      })),
    ),
  );
  assert.deepEqual(checks.nodeControls, expected, "Bundle controls must prove all 16 exact cases");
  assertEdgeResult(checks.edgeVm);
  assert.match(checks.bundleSha256, /^[a-f0-9]{64}$/);
  assert.ok(path.isAbsolute(checks.bundlePath));
  assert.deepEqual(checks.externalImports, []);
}

async function bundleProofs({ tarball, out }, report, evidence) {
  const { app, sdkRoot } = await installConsumer(tarball, "bundle", [], evidence);
  report.details.consumer = app;
  report.details.sdkRoot = sdkRoot;
  const esbuild = createRequire(import.meta.url)("esbuild");
  report.versions.esbuild = esbuild.version;
  const bundleDir = path.join(out, "bundles");
  fs.mkdirSync(bundleDir, { recursive: true });
  const results = [];
  report.checks.nodeControls = results;

  function source(name, format) {
    const from = (names, entry) =>
      format === "esm"
        ? `import {${names}} from '${entry}';`
        : `const {${names}} = require('${entry}');`;
    const imports =
      name === "node-bare-import"
        ? `${format === "esm" ? "import '@solwyn/sdk/node';" : "require('@solwyn/sdk/node');"} ${from("Solwyn,noopLogger", "@solwyn/sdk")}`
        : from(
            name === "node-run-used" ? "Solwyn,noopLogger,run" : "Solwyn,noopLogger",
            name === "core-explicit-close" ? "@solwyn/sdk" : "@solwyn/sdk/node",
          );
    return `${imports}
${from("FakeControlPlane", "@solwyn/sdk/testing")}
(async () => {
const plane=new FakeControlPlane();
let dispatched=0;
const provider={chat:{completions:{create(){dispatched++;return {usage:{prompt_tokens:2,completion_tokens:3}};}}}};
const client=new Solwyn(provider,{apiKey:plane.apiKey,apiUrl:plane.apiUrl,fetch:plane.fetch,leaseEnabled:false,logger:noopLogger,reportUntrackedSurfaces:false,reporterFlushInterval:60});
globalThis.reviewClient=client;
await ${name === "node-run-used" ? "run('bundle-review',()=>client.chat.completions.create({model:'gpt-review'}))" : "client.chat.completions.create({model:'gpt-review'})"};
${name === "core-explicit-close" ? "await client.close();" : ""}
process.once('exit',()=>process.stdout.write(JSON.stringify({dispatched,registration:typeof Reflect.get(globalThis,Symbol.for('@solwyn/sdk/node-reporter-registration')),checks:plane.checks.length,confirms:plane.confirms.length,ingested:plane.ingested.length})+'\\n'));
})().catch(() => { process.exitCode = 1; });
`;
  }
  const names = ["node-reexport", "node-bare-import", "node-run-used", "core-explicit-close"];
  for (const format of ["esm", "cjs"]) {
    const extension = format === "esm" ? "mjs" : "cjs";
    for (const name of names) {
      const contents = source(name, format);
      fs.writeFileSync(path.join(bundleDir, `${name}-entry.${extension}`), contents);
      for (const ignoreAnnotations of [false, true]) {
        const label = `${format}-${name}-${ignoreAnnotations ? "ignore-annotations" : "default"}`;
        const bundle = await esbuild.build({
          stdin: { contents, sourcefile: `${name}.${extension}`, resolveDir: app },
          bundle: true,
          platform: "node",
          format,
          target: "node20",
          treeShaking: true,
          ignoreAnnotations,
          write: false,
          metafile: true,
          logLevel: "silent",
        });
        const filename = path.join(bundleDir, `${label}.${extension}`);
        fs.writeFileSync(filename, bundle.outputFiles[0].text);
        fs.writeFileSync(
          path.join(bundleDir, `${label}-meta.json`),
          JSON.stringify(bundle.metafile, null, 2),
        );
        const execution = await commandResult(process.execPath, [filename], app, 15000, evidence);
        assert.equal(execution.status, 0, `${label} execution failed`);
        const result = JSON.parse(execution.stdout.trim());
        assert.equal(
          result.registration,
          name === "core-explicit-close" ? "undefined" : "function",
          label,
        );
        assert.equal(result.ingested, 1, label);
        assert.equal(result.confirms, 1, label);
        assert.equal(result.dispatched, 1, label);
        assert.equal(bundle.warnings.length, 0, label);
        assert.ok(
          Object.keys(bundle.metafile.inputs).some((input) =>
            input.endsWith(
              `/dist/${name === "node-reexport" || name === "node-run-used" ? "node" : "index"}.${format === "esm" ? "js" : "cjs"}`,
            ),
          ),
          `${label} must consume expected distribution format`,
        );
        results.push({
          label,
          format,
          ignoreAnnotations,
          status: execution.status,
          result,
          warnings: [],
        });
      }
    }
  }
  fs.writeFileSync(
    path.join(out, "tree-shaking-results.json"),
    JSON.stringify({ esbuild: esbuild.version, results }, null, 2),
  );

  const edgeSource = `import {Solwyn,noopLogger,getCurrentRun} from '@solwyn/sdk';
import {createSolwynMiddleware} from '@solwyn/sdk/ai-sdk';
import {FakeControlPlane} from '@solwyn/sdk/testing';
globalThis.reviewDone=(async()=>{
  let unexpectedFetch=0;
  globalThis.fetch=()=>{unexpectedFetch++;throw new Error('Unexpected external fetch');};
  const plane=new FakeControlPlane();
  let providerCalls=0;
  const delivered=[];
  const fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url);if(url.pathname==='/api/v1/metadata/ingest')delivered.push(...JSON.parse(init.body));return plane.fetch(input,init);};
  const warnings=[];
  const logger={debug(){},info(){},warn(message){warnings.push(message);},error(message){warnings.push(message);}};
  const provider={chat:{completions:{create(params){providerCalls++;if(params.stream)return(async function*(){yield{usage:{prompt_tokens:2,completion_tokens:3}}})();return{usage:{prompt_tokens:2,completion_tokens:3}};}}}};
  const client=new Solwyn(provider,{apiKey:plane.apiKey,apiUrl:plane.apiUrl,fetch,leaseEnabled:false,budgetCheckCacheTtl:0,reportUntrackedSurfaces:false,logger});
  await client.chat.completions.create({model:'gpt-review'});
  for await(const part of await client.chat.completions.create({model:'gpt-review',stream:true})){void part;}
  await client.close();
  const coreClosed={checks:plane.checks.length,confirms:plane.confirms.length,ingested:plane.ingested.length};
  const middleware=createSolwynMiddleware({apiKey:plane.apiKey,apiUrl:plane.apiUrl,fetch,leaseEnabled:false,budgetCheckCacheTtl:0,logger});
  const params={prompt:[],maxOutputTokens:1};
  const model={provider:'openai',modelId:'gpt-review'};
  await middleware.middleware.wrapGenerate({params,model,doGenerate:async()=>({usage:{inputTokens:2,outputTokens:3},content:[]})});
  const streamed=await middleware.middleware.wrapStream({params,model,doStream:async()=>({stream:new ReadableStream({start(controller){controller.enqueue({type:'finish',usage:{inputTokens:2,outputTokens:3},finishReason:'stop'});controller.close();}})})});
  const reader=streamed.stream.getReader();for(;;){const part=await reader.read();if(part.done)break;}
  await middleware.close();
  const uniqueCalls=new Set(delivered.map(event=>event.call_id)).size;
  const uniqueLegacyKeys=new Set(delivered.map(event=>event.timestamp+'|'+event.sdk_instance_id)).size;
  const result={providerCalls,checks:plane.checks.length,confirms:plane.confirms.length,transmittedEvents:delivered.length,uniqueCalls,ingested:plane.ingested.length,legacyDedupCollisions:delivered.length-uniqueLegacyKeys,unexpectedFetch,ambientRunAbsent:getCurrentRun()===undefined,nodeGlobalAbsent:typeof process==='undefined',bufferAbsent:typeof Buffer==='undefined',coreClosed,warnings};
  if(result.providerCalls!==2||result.checks!==4||result.confirms!==4||result.transmittedEvents!==4||uniqueCalls!==4||result.ingested!==4||uniqueLegacyKeys!==4||result.legacyDedupCollisions!==0||unexpectedFetch!==0||!result.ambientRunAbsent||!result.nodeGlobalAbsent||!result.bufferAbsent)throw new Error('Edge verification failed: '+JSON.stringify(result));
  globalThis.reviewResult={ok:true,...result};
  if(typeof document!=='undefined')document.body.textContent=JSON.stringify(globalThis.reviewResult);
  return globalThis.reviewResult;
})().catch(error=>{globalThis.reviewResult={ok:false,error:error.name,message:error.message};if(typeof document!=='undefined')document.body.textContent=JSON.stringify(globalThis.reviewResult);throw error;});
`;
  fs.writeFileSync(path.join(bundleDir, "edge-entry.mjs"), edgeSource);
  const edge = await esbuild.build({
    stdin: { contents: edgeSource, sourcefile: "edge-entry.mjs", resolveDir: app },
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const edgeCode = edge.outputFiles[0].text;
  fs.writeFileSync(path.join(out, "edge-browser-bundle.js"), edgeCode);
  fs.writeFileSync(
    path.join(bundleDir, "edge-bundle-meta.json"),
    JSON.stringify(edge.metafile, null, 2),
  );
  fs.writeFileSync(
    path.join(out, "edge.html"),
    '<!doctype html><meta charset="utf-8"><title>SDK edge verification</title><body>pending<script src="./edge-browser-bundle.js"></script>',
  );
  const context = vm.createContext({
    crypto: webcrypto,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    ReadableStream,
    TransformStream,
    WritableStream,
    AbortController,
    AbortSignal,
    DOMException,
    TextEncoder,
    TextDecoder,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => {
      throw new Error("Unexpected external fetch");
    },
  });
  vm.runInContext(edgeCode, context, { timeout: 10000 });
  const vmResult = await context.reviewDone;
  assert.equal(vmResult.ok, true);
  assert.deepEqual(
    Object.values(edge.metafile.outputs).flatMap((output) => output.imports),
    [],
  );
  assert.equal(vmResult.ingested, 4);
  assert.equal(vmResult.legacyDedupCollisions, 0);
  fs.writeFileSync(
    path.join(out, "edge-vm-results.json"),
    JSON.stringify(
      {
        status: 0,
        result: vmResult,
        bundleBytes: edgeCode.length,
        externalImports: Object.values(edge.metafile.outputs).flatMap((output) => output.imports),
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({
      esbuild: esbuild.version,
      treeShaking: results.map(({ label, result, status }) => ({ label, result, status })),
      edgeVm: vmResult,
    })}\n`,
  );

  report.checks.edgeVm = JSON.parse(JSON.stringify(vmResult));
  report.checks.bundleSha256 = sha256(path.join(out, "edge-browser-bundle.js"));
  report.checks.bundlePath = path.join(out, "edge-browser-bundle.js");
  report.checks.externalImports = Object.values(edge.metafile.outputs).flatMap(
    (output) => output.imports,
  );
  assertBundleChecks(report.checks);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runProbe("bundle-proofs", bundleProofs);
}
