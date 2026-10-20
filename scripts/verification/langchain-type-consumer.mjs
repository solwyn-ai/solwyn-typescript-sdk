/** Locked, strict LangChain docs recipe consumers in both module formats. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { extractLangchainRecipe } from "./langchain-consumer.mjs";
import { repositoryRoot } from "./support.mjs";
import {
  collectCompilerCells,
  commandSucceeded,
  packageVersion,
  runTypeConsumerProbe,
  strictCompilerOptions,
  writeJson,
} from "./type-consumer-support.mjs";

const probe = "langchain-type-consumer";
const dependencyFixture = path.join(
  repositoryRoot,
  "scripts/verification/fixtures/langchain-smoke",
);
const fixtureHashes = {
  manifest: "6d08e295ae9ef83819a9578ad52e6b6901d782184ef8a500ec148c9b0050023b",
  lock: "65457c2b144b2da269a07b76a1dad1385fbfed900f74be8bb4d57074253b8262",
};
const compilerVersions = { floor: "5.8.3", current: "6.0.3" };
const peerVersions = {
  core: "1.2.18",
  langchainOpenai: "1.6.2",
  langgraph: "1.5.1",
  openai: "7.36.0",
  typesNode: "22.15.30",
  zod: "4.4.3",
};
try {
  const { report, resultFile } = await runTypeConsumerProbe(
    {
      probe,
      kind: "langchain",
      tempPrefix: "solwyn-langchain-types-",
      dependencyFixture,
      fixtureHashes,
      compilerVersions,
      peerVersions,
      installFailureMessage: "Locked LangChain consumer npm ci failed",
    },
    async (context) => {
      const { consumerRoot, report } = context;
      const packages = {
        core: "@langchain/core",
        langchainOpenai: "@langchain/openai",
        langgraph: "@langchain/langgraph",
        openai: "openai",
        typesNode: "@types/node",
        zod: "zod",
      };
      report.versions.sdk = packageVersion(consumerRoot, "@solwyn/sdk");
      for (const [key, name] of Object.entries(packages)) {
        report.versions[key] = packageVersion(consumerRoot, name);
        assert.equal(report.versions[key], peerVersions[key]);
      }
      const lock = JSON.parse(
        fs.readFileSync(path.join(dependencyFixture, "package-lock.json"), "utf8"),
      );
      assert.deepEqual(
        Object.keys(lock.packages).filter((key) => /(?:^|\/)node_modules\/openai$/.test(key)),
        ["node_modules/openai"],
      );
      assert.deepEqual(
        report.details.lockedDependencyTree
          .filter((entry) => entry.name === "openai")
          .map((entry) => entry.version),
        [peerVersions.openai],
        "Installed LangChain fixture must contain exactly one OpenAI SDK",
      );
      report.checks.singleOpenai = true;
      const document = fs.readFileSync(
        path.join(repositoryRoot, "docs/integrations/langchain.md"),
        "utf8",
      );
      for (const extension of ["mts", "cts"])
        fs.writeFileSync(
          path.join(consumerRoot, `recipe.${extension}`),
          extractLangchainRecipe(document, { commonjs: extension === "cts" }),
        );
      report.checks.cells = await collectCompilerCells(
        context,
        compilerVersions,
        async ({ label, version, compilerPackage, extension, format, tsc }) => {
          const config = path.join(consumerRoot, `tsconfig-${label}-${extension}.json`);
          const files = [`recipe.${extension}`];
          writeJson(config, {
            compilerOptions: { ...strictCompilerOptions, types: ["node"] },
            files,
          });
          const command = await context.execute(
            `recipe-${label}-${format}`,
            process.execPath,
            [tsc, "-p", config],
            { timeout: 60_000 },
          );
          assert.ok(commandSucceeded(command), `${label} ${format} docs recipe failed`);
          return {
            compiler: { label, version, package: compilerPackage },
            format,
            files,
            strict: true,
            skipLibCheck: false,
            status: "pass",
            command,
          };
        },
      );
      const req = createRequire(path.join(consumerRoot, "package.json"));
      const ts = req("typescript-current");
      const emit = (source) =>
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText;
      for (const helper of ["offline-guard", "integration-env", "fake-openai-transport"]) {
        const source = fs
          .readFileSync(path.join(repositoryRoot, `tests/helpers/${helper}.ts`), "utf8")
          .replace('from "./offline-guard"', 'from "./offline-guard.mjs"');
        fs.writeFileSync(path.join(consumerRoot, `${helper}.mjs`), emit(source));
      }
      let runtimeSource = extractLangchainRecipe(document);
      const replace = (from, to) => {
        assert.equal(runtimeSource.split(from).length, 2);
        runtimeSource = runtimeSource.replace(from, to);
      };
      replace(
        "new OpenAI({ maxRetries: 0 })",
        'new OpenAI({ apiKey: "synthetic-unused", maxRetries: 0, fetch: transport.fetch })',
      );
      replace(
        "apiKey: process.env.SOLWYN_API_KEY!,",
        "apiKey: plane.apiKey, apiUrl: plane.apiUrl, fetch: plane.fetch, leaseEnabled: false, budgetCheckCacheTtl: 0,",
      );
      runtimeSource = `import { FakeControlPlane } from "@solwyn/sdk/testing";\nimport { createFakeOpenAITransport } from "./fake-openai-transport.mjs";\nexport const plane = new FakeControlPlane();\nexport const transport = createFakeOpenAITransport();\n${runtimeSource}`;
      fs.writeFileSync(path.join(consumerRoot, "recipe-runtime.mjs"), emit(runtimeSource));
      fs.writeFileSync(
        path.join(consumerRoot, "run-recipe.mjs"),
        `import assert from 'node:assert/strict';\nimport {installIntegrationEnv} from './integration-env.mjs';\nconst env=installIntegrationEnv();\ntry{const {plane,transport}=await import('./recipe-runtime.mjs');assert.equal(transport.requests.length,3);assert.equal(plane.checks.length,3);assert.equal(plane.ingested.length,3);assert.equal(plane.untrackedReports.length,0);assert.equal(env.fetchAttempts.length,0);assert.equal(env.socketAttempts(),0);process.stdout.write(JSON.stringify({dispatches:3,checks:3,ingested:3,unexpectedFetch:0,socketAttempts:0}));}finally{env.restore();}\n`,
      );
      const runtime = await context.execute("execute-docs-recipe", process.execPath, [
        "run-recipe.mjs",
      ]);
      assert.ok(commandSucceeded(runtime), "Installed docs recipe execution failed");
      report.checks.recipe = { compiled: true, result: JSON.parse(runtime.stdout) };
      report.checks.fixture.evidence = path.join(
        path.dirname(context.resultFile),
        "langchain-smoke-package-lock.json",
      );
      // Evidence uses the fixture hash's LF normalization; installed copies retain checkout bytes.
      fs.writeFileSync(
        report.checks.fixture.evidence,
        fs
          .readFileSync(path.join(consumerRoot, "package-lock.json"), "utf8")
          .replace(/\r\n?/g, "\n"),
      );
      context.persist();
    },
  );
  if (report.status === "pass") process.stdout.write(`${probe}: pass (${resultFile})\n`);
  else {
    process.stderr.write(`${report.details.error ?? `${probe} failed`}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
