import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
// createProgram checks the full SDK type graph; slower CI CPUs need a separate budget from
// Vitest's 5-second unit default. This changes no runtime or transport timing behavior.
const COMPILER_TEST_TIMEOUT_MS = 30_000;
const releasePolicy = new URL("../../scripts/release-policy.mjs", import.meta.url).href;

function releaseChannel(version: string): "latest" | "next" {
  const program = `import {releaseChannel} from ${JSON.stringify(releasePolicy)};process.stdout.write(releaseChannel(${JSON.stringify(version)}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(["latest", "next"]).toContain(result.stdout);
  return result.stdout as "latest" | "next";
}

function expectReleaseCompatibility(readme: string, version: string): void {
  const channel = releaseChannel(version);
  expect(readme).toContain(`npm install @solwyn/sdk@${channel}`);
  expect(readme).toContain(`pnpm add @solwyn/sdk@${channel}`);
  if (channel === "next") {
    expect(readme).toMatch(/prerelease[^\n]*`next`/i);
    expect(readme).toMatch(
      /if npm does not[^.]*list this version[^.]*registry installation is unavailable/i,
    );
    expect(readme).not.toMatch(/will be available[^.]*bootstrap publication/i);
  }
  if (version.startsWith("0.")) {
    expect(readme).toContain(`Public preview (\`${version}\`)`);
  } else {
    expect(readme).not.toMatch(/Public preview/i);
  }
}

function testingSection(): string {
  const match = README.match(/^## Testing budget enforcement\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  expect(match, "README must include a Testing budget enforcement section").not.toBeNull();
  return match?.[1] ?? "";
}

function fixtureRecipe(): string {
  const fixture = testingSection().match(/```ts\s+(import \{ expect, test \}[\s\S]*?)```/)?.[1];
  expect(fixture, "Testing guide must include the opt-in Vitest fixture recipe").toBeDefined();
  return fixture ?? "";
}

function compileFixture(source: string): string[] {
  const directory = mkdtempSync(join(process.cwd(), "tests/unit/.readme-fixture-"));
  const fixturePath = join(directory, "fixture.ts");
  const localTestingEntry = relative(directory, join(process.cwd(), "src/testing/index"))
    .split(sep)
    .join("/");
  const compilable = source.replace(
    'from "@solwyn/sdk/testing"',
    `from "${localTestingEntry.startsWith(".") ? localTestingEntry : `./${localTestingEntry}`}"`,
  );
  writeFileSync(fixturePath, compilable);

  try {
    const config = ts.readConfigFile(join(process.cwd(), "tsconfig.json"), ts.sys.readFile);
    if (config.error !== undefined) {
      return [ts.flattenDiagnosticMessageText(config.error.messageText, "\n")];
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
    const program = ts.createProgram({ rootNames: [fixturePath], options: parsed.options });
    return ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === fixturePath)
      .map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        return `TS${diagnostic.code}: ${message}`;
      });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("README testing guide", () => {
  it("documents the fake control-plane boundaries and supported workflows", () => {
    const section = testingSection();

    expect(section).toMatch(/zero[- ]network/i);
    expect(section).toMatch(/live `fetch` or URL[\s\S]*caller/i);
    expect(section).toMatch(/never computes? prices?/i);
    expect(section).toMatch(/never (?:reads|sees).*prompt.*response content/i);
    expect(section).toMatch(/run-scoped magic models.*`run\(\)`.*`@solwyn\/sdk\/node`/is);
    expect(section).toContain('from "@solwyn/sdk/testing"');
    expect(section).toContain('from "@solwyn/sdk/node"');
    expect(section).toContain("plane.wrap(");
    expect(section).toContain("plane.denyNext(");
    expect(section).toContain("plane.outage(");
    expect(section).toContain("plane.stopRun(");
    expect(section).toContain("denialOnlyOpenAIClient()");
    expect(section).toMatch(/finally\s*{[\s\S]*?await client\.close\(\)/);
    expect(section).toMatch(/fake contract.*live contract/is);
    expect(section).toMatch(/caller-provisioned .*state/i);
    expect(section).toMatch(/does not auto-register.*Vitest/i);
  });

  it("includes the complete seven-row magic-model table with check, lease, and run scope", () => {
    const section = testingSection();
    const table = section.match(
      /\| Model \| Check \| Lease \| Run scope \|[\s\S]*?(?=\n\n|\n```)/,
    )?.[0];
    expect(table, "Testing guide must include the magic-model table").toBeDefined();

    for (const model of [
      "solwyn-test/deny",
      "solwyn-test/deny-alert",
      "solwyn-test/deny-tag",
      "solwyn-test/deny-stopped",
      "solwyn-test/runaway",
      "solwyn-test/kill",
      "solwyn-test/lease-ineligible",
    ]) {
      expect(table).toContain(`\`${model}\``);
    }
    expect(table?.match(/^\| `solwyn-test\//gm)).toHaveLength(7);
    expect(table).toMatch(
      /deny-tag[^\n]*eligible=false[^\n]*allowed=true[^\n]*scoped_rules_present/i,
    );
    expect(table).toMatch(/deny-stopped[^\n]*run_stopped[^\n]*hard_deny[^\n]*yes/i);
    expect(table).toMatch(/runaway[^\n]*first[^\n]*allowed[^\n]*later[^\n]*agent_run[^\n]*yes/i);
    expect(table).toMatch(/kill[^\n]*first[^\n]*allowed[^\n]*later[^\n]*run_stopped[^\n]*yes/i);
    expect(table).toMatch(
      /lease-ineligible[^\n]*allowed[^\n]*eligible=false[^\n]*zero_rate_model/i,
    );
  });

  it("shows an explicit Vitest fixture with failure-safe client and plane teardown", () => {
    const fixture = fixtureRecipe();

    expect(fixture).toContain("test.extend<");
    expect(fixture).toContain("new FakeControlPlane()");
    expect(fixture).toContain("await use(plane)");
    expect(fixture).toContain("plane.unmatchedRequests");
    expect(fixture).toContain("plane.wrap(denialOnlyOpenAIClient()");
    expect(fixture).toContain("leaseEnabled: false");
    expect(fixture).toContain("await use(client)");
    expect(fixture).toMatch(
      /client:[\s\S]*?try\s*{[\s\S]*?await use\(client\)[\s\S]*?finally\s*{[\s\S]*?await client\.close\(\)/,
    );
    expect(fixture).toMatch(
      /plane:[\s\S]*?try\s*{[\s\S]*?await use\(plane\)[\s\S]*?finally\s*{[\s\S]*?expect\(plane\.unmatchedRequests\)\.toEqual\(\[\]\)/,
    );
  });

  it(
    "keeps the denial-only provider surface callable through the documented fixture",
    () => {
      const fixture = fixtureRecipe();
      const consumer = `
solwynTest("preserves the wrapped client surface", async ({ client }) => {
  await client.chat.completions.create();
});
`;

      expect(compileFixture(`${fixture}${consumer}`)).toEqual([]);
    },
    COMPILER_TEST_TIMEOUT_MS,
  );

  it("does not make Vitest a package runtime, optional, or peer dependency", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      expect(PACKAGE_JSON[field]?.["vitest"], `${field} must not include vitest`).toBeUndefined();
    }
  });
});

describe("README release compatibility guide", () => {
  it("matches the current release channel and separates EOL Node 20 support from release lanes", () => {
    expectReleaseCompatibility(README, PACKAGE_JSON.version);
    expect(README).toMatch(/Node\.js 20[^.]*end-of-life \(EOL\)[^.]*installed artifact/i);
    expect(README).toMatch(/Node\.js 22 and 24[^.]*development and release lanes/i);
    expect(README).toMatch(/`ESNext\.Disposable`[^.]*`Symbol\.asyncDispose`/i);
  });

  it("derives stable and prerelease npm channels from canonical release policy", () => {
    expect(releaseChannel("1.2.3")).toBe("latest");
    expect(releaseChannel("1.2.3-rc.1")).toBe("next");
    expect(releaseChannel("1.2.3-beta.4")).toBe("next");
  });

  it.each([
    [
      "stable 0.x preview",
      "0.9.0",
      "npm install @solwyn/sdk@latest\npnpm add @solwyn/sdk@latest\nPublic preview (`0.9.0`)",
    ],
    ["stable 1.x release", "1.0.0", "npm install @solwyn/sdk@latest\npnpm add @solwyn/sdk@latest"],
  ])("accepts %s README guidance", (_name, version, readme) => {
    expectReleaseCompatibility(readme, version);
  });

  it("publishes bounded peer intervals without promoting the legacy Google surface to a peer", () => {
    for (const [packageName, peerRange] of [
      ["@anthropic-ai/sdk", ">=0.30.0 <1"],
      ["@aws-sdk/client-bedrock-runtime", ">=3.422.0 <4"],
      ["@google/genai", ">=0.3.1 <3"],
      ["ai", ">=7.0.14 <8"],
      ["openai", ">=4.41.0 <7"],
      ["together-ai", ">=0.16.0 <1"],
    ]) {
      expect(README).toContain(`\`${packageName}\` | \`${peerRange}\``);
    }
    expect(README).toMatch(/`@google\/generative-ai`[^\n]*0\.24\.1[^\n]*not an optional peer/i);
    expect(README).toMatch(/boundary cells[^.]*not continuous-version coverage/i);
    expect(README).not.toMatch(/AI SDK (?:5|6)\b/i);
  });
});
