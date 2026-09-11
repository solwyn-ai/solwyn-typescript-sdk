/** Strict native provider declarations against a genuinely installed SDK tarball. */
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

const probe = "native-type-consumer";
const fixture = path.join(repositoryRoot, "tests/types/native-provider-remediation.ts");
const responsesFixtures = {
  mts: path.join(repositoryRoot, "tests/fixtures/post-remediation-responses-consumer.mts.fixture"),
  cts: path.join(repositoryRoot, "tests/fixtures/post-remediation-responses-consumer.cts.fixture"),
};
const dependencyFixture = path.join(repositoryRoot, "scripts/verification/fixtures/native-types");
const fixtureHashes = {
  manifest: "8333b8eb94972c6bb7da63229c1488b7b29430af30163192ef2eded874152e57",
  lock: "c61456b6d37b27f94cc4fb4bf7f397b33b6a025a24dfc700aa69bb5644fcef0c",
};
const compilerVersions = { floor: "5.8.3", current: "6.0.3" };
const peerVersions = {
  openai: "6.45.0",
  anthropic: "0.123.0",
  zod: "4.4.3",
};

try {
  const outcome = await runTypeConsumerProbe(
    {
      probe,
      kind: "native",
      tempPrefix: "solwyn-native-types-",
      dependencyFixture,
      fixtureHashes,
      compilerVersions,
      peerVersions,
      installFailureMessage: "Locked native consumer npm ci failed",
    },
    async (context) => {
      const { consumerRoot, report } = context;
      const sdkRoot = path.join(consumerRoot, "node_modules/@solwyn/sdk");
      report.versions.sdk = packageVersion(consumerRoot, "@solwyn/sdk");
      report.versions.openai = packageVersion(consumerRoot, "openai");
      report.versions.anthropic = packageVersion(consumerRoot, "@anthropic-ai/sdk");
      report.versions.zod = packageVersion(consumerRoot, "zod");
      assert.equal(report.versions.openai, peerVersions.openai);
      assert.equal(report.versions.anthropic, peerVersions.anthropic);
      assert.equal(report.versions.zod, peerVersions.zod);
      assert.equal(fs.lstatSync(sdkRoot).isSymbolicLink(), false);

      const source = fs
        .readFileSync(fixture, "utf8")
        .replace('from "../../src/index"', 'from "@solwyn/sdk"');
      assert.ok(source.includes('from "@solwyn/sdk"'));
      assert.ok(!source.includes("../../src/index"));
      for (const extension of ["mts", "cts"]) {
        fs.writeFileSync(path.join(consumerRoot, `consumer.${extension}`), source);
        fs.copyFileSync(
          responsesFixtures[extension],
          path.join(consumerRoot, `responses-consumer.${extension}`),
        );
      }
      report.details.sources = { native: fixture, responses: responsesFixtures };

      const compilerOptions = { ...strictCompilerOptions, types: [] };
      const cells = await collectCompilerCells(
        context,
        compilerVersions,
        async ({ label, version, compilerPackage, extension, format, tsc }) => {
          const config = path.join(consumerRoot, `tsconfig-${label}-${extension}.json`);
          const files = [`consumer.${extension}`, `responses-consumer.${extension}`];
          writeJson(config, { compilerOptions, files });
          const command = await context.execute(
            `typescript-${label}-${format}`,
            process.execPath,
            [tsc, "-p", config],
            { timeout: 60_000 },
          );
          return {
            compiler: { label, version, package: compilerPackage },
            format,
            files,
            strict: true,
            skipLibCheck: false,
            status: commandSucceeded(command) ? "pass" : "fail",
            command,
          };
        },
      );
      report.checks.cells = cells;
      report.checks.compilerFloorRecommendation = compilerVersions.floor;
      context.persist();
      for (const cell of cells)
        assert.equal(
          cell.status,
          "pass",
          `${cell.compiler.label} ${cell.format} native declarations failed`,
        );
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
