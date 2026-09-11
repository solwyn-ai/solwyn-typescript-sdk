import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const catalogPath = join(repositoryRoot, "tests", "provider-surface-intervals.json");
const matrixCliPath = join(repositoryRoot, "scripts", "provider-surface-matrix.mjs");

interface CatalogCell {
  readonly family: string;
  readonly interval: string;
  readonly packages: readonly string[];
}

interface SurfaceCatalog {
  readonly schema_version: 1;
  readonly include: readonly CatalogCell[];
}

async function executeWorkflowCatalog(eventName: string): Promise<readonly CatalogCell[]> {
  const outputDirectory = await mkdtemp(join(tmpdir(), "provider-surface-matrix-"));
  const scriptsDirectory = join(outputDirectory, "scripts");
  const testsDirectory = join(outputDirectory, "tests");
  const scratchCliPath = join(scriptsDirectory, "provider-surface-matrix.mjs");
  const scratchCatalogPath = join(testsDirectory, "provider-surface-intervals.json");
  const outputPath = join(outputDirectory, "github-output");

  try {
    await mkdir(scriptsDirectory);
    await mkdir(testsDirectory);
    await copyFile(matrixCliPath, scratchCliPath);
    await copyFile(catalogPath, scratchCatalogPath);
    await writeFile(outputPath, "");

    await execFileAsync(process.execPath, [scratchCliPath], {
      cwd: outputDirectory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_OUTPUT: outputPath,
      },
    });

    const output = await readFile(outputPath, "utf8");
    const include = output.match(/^include=(.+)$/m)?.[1];
    if (include === undefined)
      throw new Error(`workflow catalog emitted no include output for ${eventName}`);
    return JSON.parse(include) as readonly CatalogCell[];
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}

describe("provider surface matrix catalog command", () => {
  it("preserves every reviewed catalog cell for pull requests and pushes", async () => {
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as SurfaceCatalog;

    await expect(executeWorkflowCatalog("pull_request")).resolves.toEqual(catalog.include);
    await expect(executeWorkflowCatalog("push")).resolves.toEqual(catalog.include);
  });

  it("selects latest cells and rewrites every scoped or unscoped pin on schedule", async () => {
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as SurfaceCatalog;
    const scheduled = await executeWorkflowCatalog("schedule");
    const latestCatalogRows = catalog.include.filter((cell) => cell.interval === "latest");

    expect(scheduled.map(({ family, interval }) => ({ family, interval }))).toEqual(
      latestCatalogRows.map(({ family, interval }) => ({ family, interval })),
    );
    expect(scheduled).toHaveLength(6);
    expect(scheduled.flatMap((cell) => cell.packages)).toEqual([
      "@anthropic-ai/sdk@latest",
      "@aws-sdk/client-bedrock-runtime@latest",
      "@google/genai@latest",
      "@google/generative-ai@latest",
      "openai@latest",
      "together-ai@latest",
    ]);
  });
});
