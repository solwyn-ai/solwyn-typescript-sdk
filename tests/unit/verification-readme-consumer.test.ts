import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const helperUrl = new URL("../../scripts/verification/readme-consumer.mjs", import.meta.url).href;
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

type ReadmeAiConsumer = {
  installCommand: string;
  packageNames: string[];
  source: string;
  sourceSha256: string;
};

async function extractor() {
  const module = (await import(helperUrl)) as {
    extractReadmeAiConsumer?: (source: string) => ReadmeAiConsumer;
    readmeAiLockedVersions?: Record<string, string>;
    resolveReadmeAiPackages?: (
      packageNames: string[],
      lockedVersions: Record<string, string>,
    ) => Array<{ name: string; spec: string; version: string }>;
    assertReadmeAiConsumerChecks?: (checks: unknown) => void;
  };
  expect(module.extractReadmeAiConsumer).toBeTypeOf("function");
  if (module.extractReadmeAiConsumer === undefined)
    throw new Error("README AI consumer extractor is unavailable");
  expect(module.resolveReadmeAiPackages).toBeTypeOf("function");
  if (module.resolveReadmeAiPackages === undefined)
    throw new Error("README AI package resolver is unavailable");
  return {
    extract: module.extractReadmeAiConsumer,
    lockedVersions: module.readmeAiLockedVersions ?? {},
    resolve: module.resolveReadmeAiPackages,
    assertChecks: module.assertReadmeAiConsumerChecks,
  };
}

it("extracts the exact Vercel AI SDK install and TypeScript fences from the README", async () => {
  const { extract, lockedVersions, resolve } = await extractor();
  const contract = extract(readme);

  expect(contract.installCommand).toBe("npm install ai @ai-sdk/openai");
  expect(contract.packageNames).toEqual(["ai", "@ai-sdk/openai"]);
  expect(resolve(contract.packageNames, lockedVersions)).toEqual([
    { name: "ai", spec: "ai@7.0.14", version: "7.0.14" },
    {
      name: "@ai-sdk/openai",
      spec: "@ai-sdk/openai@4.0.65",
      version: "4.0.65",
    },
  ]);
  expect(contract.source).toContain('import { generateText, wrapLanguageModel } from "ai";');
  expect(contract.source).toContain('import { openai } from "@ai-sdk/openai";');
  expect(contract.source).toContain('import { createSolwynMiddleware } from "@solwyn/sdk/ai-sdk";');
  expect(contract.sourceSha256).toBe(createHash("sha256").update(contract.source).digest("hex"));
});

it("returns changed fence content instead of a hardcoded approximation", async () => {
  const { extract } = await extractor();
  const fixture = `# SDK

## Vercel AI SDK

\`\`\`sh
npm install ai @ai-sdk/anthropic
\`\`\`

\`\`\`ts
import { streamText } from "ai";
void streamText;
\`\`\`

## Later
`;
  const contract = extract(fixture);

  expect(contract.packageNames).toEqual(["ai", "@ai-sdk/anthropic"]);
  expect(contract.source).toBe('import { streamText } from "ai";\nvoid streamText;\n');
});

it("rejects package-set drift or a missing TypeScript fence", async () => {
  const { extract, lockedVersions, resolve } = await extractor();
  expect(() => resolve(["ai", "@ai-sdk/anthropic"], lockedVersions)).toThrow(/locked package set/i);
  expect(() => resolve(["ai"], lockedVersions)).toThrow(/locked package set/i);
  expect(() => extract("## Vercel AI SDK\n\n```sh\nnpm install ai\n```")).toThrow(
    /TypeScript fence/i,
  );
});

it("validates canonical observed README compile evidence without rereading the README", async () => {
  const { assertChecks, extract, lockedVersions, resolve } = await extractor();
  expect(assertChecks).toBeTypeOf("function");
  if (assertChecks === undefined) throw new Error("README AI checks validator is unavailable");
  const contract = extract(readme);
  const packages = resolve(contract.packageNames, lockedVersions);
  const checks = {
    runtimeDependencies: ["@ai-sdk/openai", "@solwyn/sdk", "ai"],
    developmentDependencies: ["@types/json-schema", "@types/node", "typescript"],
    installCommand: contract.installCommand,
    packageNames: contract.packageNames,
    packageSpecs: packages.map(({ spec }) => spec),
    installedPackages: Object.fromEntries(packages.map(({ name, version }) => [name, version])),
    sourceSha256: contract.sourceSha256,
    strict: true,
    skipLibCheck: false,
    types: ["node"],
    lib: ["ES2023", "DOM", "ESNext.Disposable"],
  };
  expect(() => assertChecks(checks)).not.toThrow();
  for (const mutation of [
    (value: typeof checks) => {
      value.installCommand = "npm install ai";
    },
    (value: typeof checks) => {
      value.packageNames.pop();
    },
    (value: typeof checks) => {
      value.sourceSha256 = "missing";
    },
  ]) {
    const changed = structuredClone(checks);
    mutation(changed);
    expect(() => assertChecks(changed)).toThrow();
  }
});

it("derives the compiled recipe from the installed artifact README", () => {
  const verifier = readFileSync(
    new URL("../../scripts/verification/package-consumers.mjs", import.meta.url),
    "utf8",
  );
  expect(verifier).toContain('fs.readFileSync(path.join(sdkPath, "README.md"), "utf8")');
  expect(verifier).not.toContain('fs.readFileSync(path.join(root, "README.md"), "utf8")');
});
