import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { expect, it } from "vitest";
import { installIntegrationEnv } from "../helpers/integration-env";

const env = installIntegrationEnv();
function exactlyOnce(source: string, from: string, to: string): string {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}
it("strict-compiles and executes the complete documented LangChain recipe offline", async () => {
  const directory = mkdtempSync(join(process.cwd(), "tests/unit/.langchain-recipe-"));
  try {
    const doc = readFileSync(join(process.cwd(), "docs/integrations/langchain.md"), "utf8");
    const block = doc.match(/```ts\n([\s\S]*?)```/)?.[1];
    expect(block).toBeDefined();
    if (!block) throw new Error("missing recipe");
    const local = (file: string) => {
      const specifier = relative(directory, join(process.cwd(), file)).split(sep).join("/");
      return specifier.startsWith(".") ? specifier : `./${specifier}`;
    };
    let source = exactlyOnce(block, 'from "@solwyn/sdk/node"', `from "${local("src/node.ts")}"`);
    source = exactlyOnce(
      source,
      'from "@solwyn/sdk/langchain"',
      `from "${local("src/langchain/index.ts")}"`,
    );
    source = exactlyOnce(
      source,
      "new OpenAI({ maxRetries: 0 })",
      'new OpenAI({ apiKey: "synthetic-unused", maxRetries: 0, fetch: transport.fetch })',
    );
    source = exactlyOnce(
      source,
      "apiKey: process.env.SOLWYN_API_KEY!,",
      "apiKey: plane.apiKey, apiUrl: plane.apiUrl, fetch: plane.fetch, leaseEnabled: false, budgetCheckCacheTtl: 0,",
    );
    source = `import { FakeControlPlane } from "${local("src/testing/index.ts")}";\nimport { createFakeOpenAITransport } from "${local("tests/helpers/fake-openai-transport.ts")}";\nexport const plane = new FakeControlPlane();\nexport const transport = createFakeOpenAITransport();\n${source}`;
    const fixture = join(directory, "recipe.ts");
    writeFileSync(fixture, source);
    const config = ts.readConfigFile(join(process.cwd(), "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
    const program = ts.createProgram({
      rootNames: [fixture],
      options: { ...parsed.options, allowImportingTsExtensions: true },
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    expect(diagnostics).toEqual([]);
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const executable = join(directory, "recipe.mjs");
    writeFileSync(executable, output);
    const result = await import(/* @vite-ignore */ pathToFileURL(executable).href);
    expect(result.transport.requests).toHaveLength(3);
    expect(result.plane.checks).toHaveLength(3);
    expect(result.plane.ingested).toHaveLength(3);
    expect(result.plane.untrackedReports).toHaveLength(0);
    expect(env.fetchAttempts).toEqual([]);
    expect(env.socketAttempts()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    env.restore();
  }
}, 60_000);
