import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FakeControlPlane } from "../../src/testing/index";
import type { FakeOpenAITransport } from "../helpers/fake-openai-transport";
import { installIntegrationEnv } from "../helpers/integration-env";

let env: ReturnType<typeof installIntegrationEnv>;
beforeAll(() => {
  env = installIntegrationEnv();
});
afterAll(() => env.restore());

function replaceOnce(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, after);
}

it("compiles and executes the published OpenAI Agents recipe with offline transports", async () => {
  const guide = readFileSync(join(process.cwd(), "docs/integrations/openai-agents.md"), "utf8");
  const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)];
  const recipe = blocks[0]?.[1];
  expect(recipe).toBeDefined();
  if (recipe === undefined) throw new Error("missing Agents recipe");
  const directory = mkdtempSync(join(process.cwd(), "tests/unit/.openai-agents-docs-"));
  try {
    let source = replaceOnce(recipe, 'from "@solwyn/sdk/node"', 'from "../../../src/node"');
    source = replaceOnce(
      source,
      'from "@solwyn/sdk/openai-agents"',
      'from "../../../src/openai-agents/index"',
    );
    source = replaceOnce(
      source,
      "new OpenAI({ maxRetries: 0 })",
      'new OpenAI({ apiKey: "synthetic-unused", fetch: transport.fetch, maxRetries: 0 })',
    );
    source = replaceOnce(
      source,
      "{ apiKey: process.env.SOLWYN_API_KEY! }",
      '{ apiKey: plane.apiKey, apiUrl: plane.apiUrl, fetch: plane.fetch, onUnmetered: "raise" }',
    );
    source = `import { FakeControlPlane } from "../../../src/testing/index";
import { createFakeOpenAITransport } from "../../helpers/fake-openai-transport";
const plane = new FakeControlPlane();
const transport = createFakeOpenAITransport();
${source}
export { plane, transport };
`;
    const fixturePath = join(directory, "fixture.ts");
    writeFileSync(fixturePath, source);
    const config = ts.readConfigFile(join(process.cwd(), "tsconfig.json"), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
    const program = ts.createProgram({ rootNames: [fixturePath], options: parsed.options });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map(
        (diagnostic) =>
          `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      );
    expect(diagnostics).toEqual([]);
    const executable = join(directory, "fixture.mjs");
    // This source fixture bypasses exports; package sideEffects names the built Node entry.
    await build({
      entryPoints: [fixturePath],
      outfile: executable,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node22",
      ignoreAnnotations: true,
      logLevel: "silent",
    });
    const fixture = (await import(pathToFileURL(executable).href)) as {
      plane: FakeControlPlane;
      transport: FakeOpenAITransport;
    };
    expect(fixture.transport.requests).toHaveLength(1);
    expect(fixture.plane.checks).toHaveLength(1);
    expect(fixture.plane.confirms).toHaveLength(1);
    expect(fixture.plane.ingested).toMatchObject([
      { status: "success", agent_run_name: "agent:Triage", tags: { team: "support" } },
    ]);
    expect(fixture.plane.untrackedReports).toEqual([]);
    expect(fixture.plane.unmatchedRequests).toEqual([]);
    expect(env.fetchAttempts).toEqual([]);
    expect(env.socketAttempts()).toBe(0);
  } finally {
    const framework = await import("@openai/agents");
    // The native setter accepts clearing at runtime; its declaration only accepts OpenAI.
    Reflect.apply(framework.setDefaultOpenAIClient, undefined, [undefined]);
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
