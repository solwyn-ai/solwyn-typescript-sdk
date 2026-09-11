/** Strict AI SDK middleware declarations and their genuine upstream baseline. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repositoryRoot } from "./support.mjs";
import {
  collectCompilerCells,
  commandSucceeded,
  packageVersion,
  runTypeConsumerProbe,
  strictCompilerOptions,
  writeJson,
} from "./type-consumer-support.mjs";

const probe = "ai-type-consumer";
const dependencyFixture = path.join(repositoryRoot, "scripts/verification/fixtures/ai-types");
const fixtureHashes = {
  manifest: "80f2d9b17c6194ab0b01a3687bbb4280a634eede76565b626ccee1136f2cfccb",
  lock: "9e81ef4864b0549f664fe9215b5a1c1894828baa8d53753d6b29c9e1f74f661f",
};
const compilerVersions = { diagnostic: "5.7.3", floor: "5.8.3", current: "6.0.3" };
const requiredCompilerVersions = {
  floor: compilerVersions.floor,
  current: compilerVersions.current,
};
const peerVersions = {
  ai: "7.0.14",
  typesJsonSchema: "7.0.15",
  typesNode: "22.15.30",
  zod: "4.4.3",
};

const consumerSource = `import { wrapLanguageModel } from "ai";
import {
  createSolwynMiddleware,
  type SolwynMiddlewareHandle,
} from "@solwyn/sdk/ai-sdk";

declare const model: Parameters<typeof wrapLanguageModel>[0]["model"];
const handle: SolwynMiddlewareHandle = createSolwynMiddleware({});
const wrapped = wrapLanguageModel({ model, middleware: handle.middleware });
void wrapped;
`;
const baselineSource = `import { wrapLanguageModel } from "ai";

declare const model: Parameters<typeof wrapLanguageModel>[0]["model"];
const wrapped = wrapLanguageModel({ model, middleware: {} });
void wrapped;
`;

try {
  const outcome = await runTypeConsumerProbe(
    {
      probe,
      kind: "ai",
      tempPrefix: "solwyn-ai-types-",
      dependencyFixture,
      fixtureHashes,
      compilerVersions,
      peerVersions,
      installFailureMessage: "Locked AI consumer npm ci failed",
    },
    async (context) => {
      const { consumerRoot, report } = context;
      const sdkRoot = path.join(consumerRoot, "node_modules/@solwyn/sdk");
      assert.equal(fs.lstatSync(sdkRoot).isSymbolicLink(), false);
      report.versions.sdk = packageVersion(consumerRoot, "@solwyn/sdk");
      report.versions.ai = packageVersion(consumerRoot, "ai");
      report.versions.typesJsonSchema = packageVersion(consumerRoot, "@types/json-schema");
      report.versions.typesNode = packageVersion(consumerRoot, "@types/node");
      report.versions.zod = packageVersion(consumerRoot, "zod");
      assert.equal(report.versions.ai, peerVersions.ai);
      assert.equal(report.versions.typesJsonSchema, peerVersions.typesJsonSchema);
      assert.equal(report.versions.typesNode, peerVersions.typesNode);
      assert.equal(report.versions.zod, peerVersions.zod);
      for (const [label, version] of Object.entries(compilerVersions))
        assert.equal(packageVersion(consumerRoot, `typescript-${label}`), version);

      for (const extension of ["mts", "cts"]) {
        fs.writeFileSync(path.join(consumerRoot, `consumer.${extension}`), consumerSource);
        fs.writeFileSync(path.join(consumerRoot, `baseline.${extension}`), baselineSource);
      }
      report.details.sources = {
        baseline: ["baseline.mts", "baseline.cts"],
        consumer: ["consumer.mts", "consumer.cts"],
      };
      const compilerOptions = { ...strictCompilerOptions, types: ["node"] };
      const inspectType = path.join(consumerRoot, "inspect-type.cjs");
      fs.writeFileSync(
        inspectType,
        `const assert=require("node:assert/strict");\nconst path=require("node:path");\nconst root=process.argv[2];\nconst compilerPackage=process.argv[3];\nconst config=process.argv[4];\nconst wanted=process.argv[5];\nconst ts=require(path.join(root,"node_modules",compilerPackage));\nconst loaded=ts.readConfigFile(config,ts.sys.readFile);\nassert.equal(loaded.error,undefined);\nconst parsed=ts.parseJsonConfigFileContent(loaded.config,ts.sys,root);\nconst program=ts.createProgram(parsed.fileNames,parsed.options);\nconst checker=program.getTypeChecker();\nconst source=program.getSourceFile(path.join(root,wanted));\nassert.ok(source);\nconst declaration=source.statements.filter(ts.isVariableStatement).flatMap(statement=>[...statement.declarationList.declarations]).find(item=>item.name.getText()==="wrapped");\nassert.ok(declaration);\nconst type=checker.typeToString(checker.getTypeAtLocation(declaration.name));\nassert.equal(type,"LanguageModelV4");\nprocess.stdout.write(JSON.stringify({type}));\n`,
      );

      const diagnosticPackage = "typescript-diagnostic";
      const diagnosticConfig = path.join(consumerRoot, "tsconfig-baseline-diagnostic-cts.json");
      writeJson(diagnosticConfig, { compilerOptions, files: ["baseline.cts"] });
      const diagnosticCommand = await context.execute(
        "typescript-diagnostic-cjs-upstream-baseline",
        process.execPath,
        [
          path.join(consumerRoot, "node_modules", diagnosticPackage, "bin/tsc"),
          "-p",
          diagnosticConfig,
        ],
        { timeout: 60_000 },
      );
      const diagnosticOutput = `${diagnosticCommand.stdout}\n${diagnosticCommand.stderr}`;
      report.checks.upstreamBaselineDiagnostic = {
        compiler: { label: "diagnostic", version: compilerVersions.diagnostic },
        format: "cjs",
        expected: "upstream-invalid",
        status:
          !diagnosticCommand.error &&
          diagnosticCommand.status !== 0 &&
          /TS1479/.test(diagnosticOutput)
            ? "upstream-invalid"
            : "unexpected-result",
        command: diagnosticCommand,
      };
      context.persist();
      assert.equal(diagnosticCommand.error, undefined, "TypeScript 5.7 diagnostic runner failed");
      assert.notEqual(diagnosticCommand.status, 0, "TypeScript 5.7 CJS upstream baseline passed");
      assert.match(diagnosticOutput, /TS1479/, "TypeScript 5.7 diagnostic changed unexpectedly");

      const cells = await collectCompilerCells(
        context,
        requiredCompilerVersions,
        async ({ label, version, compilerPackage, extension, format, tsc }) => {
          const baselineConfig = path.join(
            consumerRoot,
            `tsconfig-baseline-${label}-${extension}.json`,
          );
          const consumerConfig = path.join(
            consumerRoot,
            `tsconfig-consumer-${label}-${extension}.json`,
          );
          writeJson(baselineConfig, { compilerOptions, files: [`baseline.${extension}`] });
          writeJson(consumerConfig, { compilerOptions, files: [`consumer.${extension}`] });
          const baseline = await context.execute(
            `typescript-${label}-${format}-upstream-baseline`,
            process.execPath,
            [tsc, "-p", baselineConfig],
            { timeout: 60_000 },
          );
          const sdk = await context.execute(
            `typescript-${label}-${format}-sdk-consumer`,
            process.execPath,
            [tsc, "-p", consumerConfig],
            { timeout: 60_000 },
          );
          const inference = commandSucceeded(sdk)
            ? await context.execute(
                `typescript-${label}-${format}-inference`,
                process.execPath,
                [
                  inspectType,
                  consumerRoot,
                  compilerPackage,
                  consumerConfig,
                  `consumer.${extension}`,
                ],
                { timeout: 60_000 },
              )
            : null;
          let status = "pass";
          if (!commandSucceeded(baseline)) status = "upstream-invalid";
          else if (!commandSucceeded(sdk)) status = "sdk-failure";
          else if (!inference || !commandSucceeded(inference)) status = "inference-failure";
          return {
            compiler: { label, version, package: compilerPackage },
            format,
            strict: true,
            skipLibCheck: false,
            status,
            baseline,
            sdk,
            inference,
          };
        },
      );
      report.checks.cells = cells;
      report.checks.compilerFloorRecommendation = compilerVersions.floor;
      context.persist();
      for (const cell of cells) {
        assert.ok(
          commandSucceeded(cell.baseline),
          `${cell.compiler.label} ${cell.format} standalone AI baseline is upstream-invalid`,
        );
        assert.ok(
          commandSucceeded(cell.sdk),
          `${cell.compiler.label} ${cell.format} AI declarations failed`,
        );
        assert.ok(
          cell.inference && commandSucceeded(cell.inference),
          `${cell.compiler.label} ${cell.format} did not infer LanguageModelV4`,
        );
      }
      report.details.compilerFloorEvidence =
        "TypeScript 5.7.3 fails the genuine AI 7.0.14 CommonJS baseline with TS1479; 5.8.3 is the first tested released compiler where ESM and CJS baselines pass.";
    },
  );
  const { report, resultFile } = outcome;
  if (report.status === "pass") process.stdout.write(`${probe}: pass (${resultFile})\n`);
  else {
    process.stderr.write(`${report.details.error ?? `${probe} failed`}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
