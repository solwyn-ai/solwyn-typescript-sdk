import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ciPath = join(repositoryRoot, ".github", "workflows", "ci.yml");
const publishPath = join(repositoryRoot, ".github", "workflows", "publish.yml");
const surfaceCatalogPath = join(repositoryRoot, "tests", "provider-surface-intervals.json");

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface WorkflowJob {
  readonly environment?: string | { readonly name?: string };
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowModel {
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly permissions?: Readonly<Record<string, string>>;
}

async function parseWorkflow(
  path: string,
): Promise<{ readonly model: WorkflowModel; readonly source: string }> {
  const source = await readFile(path, "utf8");
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  expect(
    document.errors.map((error) => error.message),
    `${path} is not valid unique-key YAML`,
  ).toEqual([]);
  expect(document.warnings.map((warning) => warning.message)).toEqual([]);
  const model = document.toJS() as WorkflowModel;
  expect(model).toBeTypeOf("object");
  expect(model.jobs).toBeTypeOf("object");
  return { model, source };
}

function semanticJob(workflow: WorkflowModel, id: string): WorkflowJob {
  const value = workflow.jobs[id];
  expect(value, `missing semantic workflow job ${id}`).toBeDefined();
  return value ?? {};
}

function namedStep(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const value = workflowJob.steps?.find((step) => step.name === name);
  expect(value, `missing workflow step ${name}`).toBeDefined();
  return value ?? {};
}

function environmentName(workflowJob: WorkflowJob): string | undefined {
  if (typeof workflowJob.environment === "string") return workflowJob.environment;
  if (workflowJob.environment && typeof workflowJob.environment === "object") {
    return workflowJob.environment.name;
  }
  return undefined;
}

function nodeHeredoc(run: string): string {
  const script = run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/)?.[1];
  expect(script, "missing Node heredoc").toBeDefined();
  return script ?? "";
}

function runBash(
  script: string,
  env: Readonly<Record<string, string>>,
  cwd = repositoryRoot,
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function executePublishStep(
  script: string,
  options: {
    readonly publishConfig: Readonly<Record<string, unknown>>;
    readonly sabotageConfig?: string;
    readonly version: string;
  },
) {
  const scratch = mkdtempSync(join(tmpdir(), "workflow-publish-security-"));
  const hostileProject = join(scratch, "hostile-project");
  const fakeBin = join(scratch, "bin");
  const archiveRoot = join(scratch, "archive");
  const packageRoot = join(archiveRoot, "package");
  const tarball = join(scratch, `solwyn-sdk-${options.version}.tgz`);
  const publishRecord = join(scratch, "publish-record.json");
  const hostileConfig = [
    "registry=https://registry.attacker.invalid/",
    "@solwyn:registry=https://scope.attacker.invalid/",
    "proxy=http://proxy.attacker.invalid/",
    "https-proxy=http://secure-proxy.attacker.invalid/",
    "strict-ssl=false",
    `cafile=${join(scratch, "attacker-ca.pem")}`,
    "ca=attacker-ca",
    "dry-run=true",
    "ignore-scripts=false",
    "access=restricted",
    "provenance=false",
  ].join("\n");
  mkdirSync(hostileProject);
  mkdirSync(fakeBin);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(hostileProject, ".npmrc"), `${hostileConfig}\n`);
  writeFileSync(join(scratch, "hostile-user.npmrc"), `${hostileConfig}\n`);
  writeFileSync(join(scratch, "attacker-ca.pem"), "attacker CA\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@solwyn/sdk",
      publishConfig: options.publishConfig,
      version: options.version,
    })}\n`,
  );
  const packed = spawnSync("tar", ["-czf", tarball, "-C", archiveRoot, "package/package.json"], {
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(`fixture tar failed: ${packed.stderr}`);
  const realNpm = spawnSync("bash", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
  writeExecutable(
    join(fakeBin, "npm"),
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "get") {
  const unsafe = {
    registry: "https://registry.attacker.invalid/",
    "@solwyn:registry": "https://scope.attacker.invalid/",
    proxy: "http://proxy.attacker.invalid/",
    "https-proxy": "http://secure-proxy.attacker.invalid/",
    "strict-ssl": "false",
    cafile: "/attacker-ca.pem",
    ca: "attacker-ca",
    "dry-run": "true",
    "ignore-scripts": "false",
    access: "restricted",
    provenance: "false",
  };
  if (process.env.SABOTAGE_CONFIG === args[2]) {
    process.stdout.write(unsafe[args[2]] + "\\n");
    process.exit(0);
  }
  const child = spawnSync(process.env.REAL_NPM, args, { env: process.env, stdio: "inherit" });
  process.exit(child.status ?? 1);
}
if (args[0] === "publish") {
  const readOptional = (path) => path === undefined ? undefined : readFileSync(path, "utf8");
  const npmConfigEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^npm_config_/i.test(name) && !/^npm_config_(?:userconfig|globalconfig)$/i.test(name)));
  const proxyEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name)));
  writeFileSync(process.env.PUBLISH_RECORD, JSON.stringify({
    args,
    cwd: process.cwd(),
    globalConfig: process.env.NPM_CONFIG_GLOBALCONFIG,
    globalConfigText: readOptional(process.env.NPM_CONFIG_GLOBALCONFIG),
    nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
    nodeTlsRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
    npmConfigEnvironment,
    proxyEnvironment,
    userConfig: process.env.NPM_CONFIG_USERCONFIG,
    userConfigText: readOptional(process.env.NPM_CONFIG_USERCONFIG),
  }));
  process.exit(0);
}
process.stderr.write("unexpected npm invocation: " + JSON.stringify(args) + "\\n");
process.exit(97);
`,
  );
  const negativeControl = spawnSync(realNpm, ["config", "get", "strict-ssl"], {
    cwd: hostileProject,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_USERCONFIG: join(scratch, "hostile-user.npmrc") },
  });
  const result = runBash(
    script,
    {
      ALL_PROXY: "http://all-proxy.attacker.invalid/",
      EXPECTED_VERSION: options.version,
      GITHUB_WORKSPACE: repositoryRoot,
      HTTPS_PROXY: "http://https-proxy.attacker.invalid/",
      HTTP_PROXY: "http://http-proxy.attacker.invalid/",
      NODE_EXTRA_CA_CERTS: join(scratch, "attacker-ca.pem"),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NPM_CONFIG_USERCONFIG: join(scratch, "hostile-user.npmrc"),
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      PUBLISH_RECORD: publishRecord,
      REAL_NPM: realNpm,
      RUNNER_TEMP: scratch,
      SABOTAGE_CONFIG: options.sabotageConfig ?? "",
      TARBALL: tarball,
      all_proxy: "http://lower-all-proxy.attacker.invalid/",
      http_proxy: "http://lower-http-proxy.attacker.invalid/",
      https_proxy: "http://lower-https-proxy.attacker.invalid/",
    },
    hostileProject,
  );
  return {
    hostileProject,
    negativeControl,
    publishRecord: existsSync(publishRecord) ? readFileSync(publishRecord, "utf8") : "",
    result,
    scratch,
    tarball,
  };
}

const pins = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
} as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function job(workflow: string, id: string): string {
  const match = workflow.match(
    new RegExp(`^  ${escapeRegExp(id)}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m"),
  );
  expect(match, `missing workflow job ${id}`).not.toBeNull();
  return match?.[0] ?? "";
}

function expectCommandsInOrder(source: string, commands: readonly string[]): void {
  let cursor = -1;
  for (const command of commands) {
    const next = source.indexOf(command, cursor + 1);
    expect(next, `missing or out-of-order command: ${command}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function expectOnlyReviewedActionPins(workflow: string): void {
  const uses = [...workflow.matchAll(/^\s*- uses:\s+([^@\s]+)@([^\s#]+)/gm)];
  expect(uses.length).toBeGreaterThan(0);
  for (const use of uses) {
    const [, action = "", revision] = use;
    expect(action in pins, `unreviewed action ${action}`).toBe(true);
    expect(revision, `wrong pin for ${action}`).toBe(pins[action as keyof typeof pins]);
  }
  expect(workflow).not.toMatch(/^\s*- uses:\s+[^@\s]+@(?![a-f0-9]{40}(?:\s|$))/gm);
}

describe("workflow YAML semantics", () => {
  it.each([
    ["CI", ciPath],
    ["publish", publishPath],
  ])("parses the %s workflow as one unique-key semantic document", async (_name, path) => {
    const { model } = await parseWorkflow(path);

    expect(Object.keys(model.jobs).length).toBeGreaterThan(0);
    expect(model.permissions).toBeTypeOf("object");
  });
});

describe("CI workflow contract", () => {
  it("runs every full source gate on exact Node 22 and 24 releases", async () => {
    const workflow = await readFile(ciPath, "utf8");
    const quality = job(workflow, "quality");

    expect(quality).toContain("runs-on: ubuntu-24.04");
    expect(quality).toContain('node-version: ["22.23.2", "24.21.0"]');
    expect(quality).toContain("pnpm install --frozen-lockfile");
    expectCommandsInOrder(quality, [
      "pnpm check",
      "pnpm test",
      "pnpm build",
      "pnpm test:dist",
      "pnpm surfaces:check",
      "pnpm check:public",
    ]);
  });

  it("packs once and verifies the uploaded bytes on both supported Node lines", async () => {
    const workflow = await readFile(ciPath, "utf8");
    const artifact = job(workflow, "package-artifact");
    const consumers = job(workflow, "artifact-consumers");

    expect(workflow.match(/ARTIFACT_DIR: \$\{\{ github\.workspace \}\}-artifact/g)).toHaveLength(3);
    expect(workflow).not.toContain("../release-artifact");
    expect(workflow.match(/release-artifact\.mjs create/g)).toHaveLength(1);
    expect(artifact).toContain("pnpm build");
    expect(workflow.match(/release-artifact\.mjs verify-directory/g)).toHaveLength(3);
    expect(workflow).not.toContain('find "$ARTIFACT_DIR"');
    expectCommandsInOrder(artifact, [
      "pnpm build",
      "release-artifact.mjs create",
      "release-artifact.mjs verify-directory",
      "pnpm check:public --artifact-dir",
      "actions/upload-artifact@",
    ]);
    expect(consumers).toContain('node-version: ["22.23.2", "24.21.0"]');
    expectCommandsInOrder(consumers, [
      "actions/download-artifact@",
      "release-artifact.mjs verify-directory",
      "pnpm test:pack -- --tarball",
      "pnpm test:consumers -- --tarball",
    ]);
    expect(consumers).not.toMatch(/\b(?:npm pack|pnpm build|release-artifact\.mjs create)\b/);
  });

  it("keeps Node 20.20.2 limited to a provider-free installed core smoke", async () => {
    const workflow = await readFile(ciPath, "utf8");
    const legacy = job(workflow, "legacy-installed-core");

    expect(legacy).toContain("node-version: 20.20.2");
    expect(legacy).toContain("release-artifact.mjs verify-directory");
    expect(legacy).toContain('npm install --ignore-scripts --no-audit --no-fund "$TARBALL"');
    expect(legacy).toContain("node --input-type=module");
    expect(legacy).toContain("node --input-type=commonjs");
    expect(legacy).toContain('from "@solwyn/sdk/node"');
    expect(legacy).toContain('require("@solwyn/sdk/node")');
    expect(legacy).toContain("nodeSdk.VERSION");
    expect(legacy).toContain("manifest.version");
    expect(legacy).not.toMatch(
      /pnpm|(?:test:consumers|test:pack)|ai-sdk|@anthropic-ai|@aws-sdk|@google|openai|together-ai|\bbuild\b/,
    );
  });

  it("preserves all provider cells and the scheduled latest canary", async () => {
    const [workflow, catalogText] = await Promise.all([
      readFile(ciPath, "utf8"),
      readFile(surfaceCatalogPath, "utf8"),
    ]);
    const catalog = JSON.parse(catalogText) as { include: readonly unknown[] };
    const inventory = job(workflow, "provider-surface-inventory");

    expect(catalog.include).toHaveLength(11);
    expect(workflow).toContain('cron: "0 6 * * 1"');
    expect(workflow).toContain("node scripts/provider-surface-matrix.mjs");
    expect(inventory).toContain("fromJSON(needs.provider-surface-matrix.outputs.include)");
    expect(inventory).toContain("pnpm add --no-lockfile -D");
    expect(inventory).toContain("git diff --exit-code -- pnpm-lock.yaml");
    expect(inventory).toContain("pnpm vitest run tests/unit/surface-canary.test.ts");
  });

  it("runs a pinned actionlint binary as part of the required quality result", async () => {
    const { model } = await parseWorkflow(ciPath);
    const validation = namedStep(semanticJob(model, "quality"), "Validate GitHub workflows");

    expect(validation.env).toEqual({
      ACTIONLINT_SHA256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
      ACTIONLINT_VERSION: "1.7.12",
    });
    expect(validation.run).toContain(
      `https://github.com/rhysd/actionlint/releases/download/v\${ACTIONLINT_VERSION}/actionlint_\${ACTIONLINT_VERSION}_linux_amd64.tar.gz`,
    );
    expect(validation.run).toContain(
      `ARCHIVE="$RUNNER_TEMP/actionlint_\${ACTIONLINT_VERSION}_linux_amd64.tar.gz"`,
    );
    expect(validation.run).not.toMatch(/\$ACTIONLINT_VERSION_[A-Za-z0-9_]/);
    expect(validation.run).toContain('echo "$ACTIONLINT_SHA256  $ARCHIVE" | sha256sum --check');
    expect(validation.run).toContain(
      '"$RUNNER_TEMP/actionlint/actionlint" .github/workflows/ci.yml .github/workflows/publish.yml',
    );
  });

  it("fans the stable required result into exactly six jobs and fails every non-success state", async () => {
    const { model } = await parseWorkflow(ciPath);
    const required = semanticJob(model, "required");
    const expectedNeeds = [
      "quality",
      "package-artifact",
      "artifact-consumers",
      "legacy-installed-core",
      "provider-surface-matrix",
      "provider-surface-inventory",
    ];
    const expectedEnvironment = {
      QUALITY: `\${{ needs.quality.result }}`,
      PACKAGE_ARTIFACT: `\${{ needs.package-artifact.result }}`,
      ARTIFACT_CONSUMERS: `\${{ needs.artifact-consumers.result }}`,
      LEGACY_INSTALLED_CORE: `\${{ needs.legacy-installed-core.result }}`,
      PROVIDER_SURFACE_MATRIX: `\${{ needs.provider-surface-matrix.result }}`,
      PROVIDER_SURFACE_INVENTORY: `\${{ needs.provider-surface-inventory.result }}`,
    };
    const gate = namedStep(required, "Require every launch gate");

    expect(required.if).toBe("always() && github.event_name != 'schedule'");
    expect(required.needs).toEqual(expectedNeeds);
    expect(gate.env).toEqual(expectedEnvironment);
    expect(
      runBash(
        gate.run ?? "",
        Object.fromEntries(Object.keys(expectedEnvironment).map((key) => [key, "success"])),
      ).status,
    ).toBe(0);
    for (const key of Object.keys(expectedEnvironment)) {
      for (const state of ["failure", "cancelled", "skipped"]) {
        const env = Object.fromEntries(
          Object.keys(expectedEnvironment).map((name) => [name, "success"]),
        );
        env[key] = state;
        expect(runBash(gate.run ?? "", env).status, `${key}=${state} must fail`).not.toBe(0);
      }
    }
  });

  it.each([
    ["CI", ciPath, "artifact-consumers"],
    ["publish", publishPath, "verify-release-artifact"],
  ])("provisions, parses, version-checks, and exports the required %s browser", async (_name, workflowPath, jobId) => {
    const { model } = await parseWorkflow(workflowPath);
    const consumers = semanticJob(model, jobId);
    const provision = namedStep(consumers, "Provision pinned Chrome for Testing");
    const scratch = mkdtempSync(join(tmpdir(), "workflow-browser-"));
    const fakeBin = join(scratch, "bin");
    const browserArgsRecord = join(scratch, "browser-args");
    const chromeSha256Record = join(scratch, "chrome-sha256");
    const curlRecord = join(scratch, "curl-url");
    const githubEnvironment = join(scratch, "github-env");
    writeFileSync(githubEnvironment, "");
    writeFileSync(curlRecord, "");
    try {
      writeFileSync(join(scratch, ".keep"), "");
      mkdirSync(fakeBin);
      writeExecutable(
        join(fakeBin, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
test -n "$output" && test -n "$url"
: > "$output"
printf '%s' "$url" > "$CURL_RECORD"
`,
      );
      writeExecutable(
        join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 1
test "$1" = "--check"
read -r digest file
test "$digest" = "$EXPECTED_CHROME_SHA256"
test -f "$file"
printf '%s %s' "$digest" "$file" > "$CHROME_SHA256_RECORD"
if [[ "\${FORCE_CHECKSUM_FAILURE:-0}" = "1" ]]; then
  printf '%s: FAILED\n' "$file" >&2
  exit 1
fi
`,
      );
      writeExecutable(
        join(fakeBin, "unzip"),
        `#!/usr/bin/env bash
set -euo pipefail
destination=""
while (($#)); do
  case "$1" in
    -d) destination="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$destination/chrome-linux64"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$@" > "$FAKE_CHROME_ARGS_RECORD"' 'printf "%s\\n" "$FAKE_CHROME_OUTPUT"' > "$destination/chrome-linux64/chrome"
chmod +x "$destination/chrome-linux64/chrome"
`,
      );
      const baseEnvironment = {
        CHROME_FOR_TESTING_SHA256: consumers.env?.["CHROME_FOR_TESTING_SHA256"] ?? "",
        CHROME_FOR_TESTING_VERSION: consumers.env?.["CHROME_FOR_TESTING_VERSION"] ?? "",
        CHROME_SHA256_RECORD: chromeSha256Record,
        FAKE_CHROME_ARGS_RECORD: browserArgsRecord,
        EXPECTED_CHROME_SHA256: "0704631fb3e4f741092e08f55272f90abc3e307f991f05f332924364415b02e0",
        CURL_RECORD: curlRecord,
        GITHUB_ENV: githubEnvironment,
        PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: scratch,
      };

      expect(consumers.env?.["CHROME_FOR_TESTING_VERSION"]).toBe("152.0.7977.82");
      expect(consumers.env?.["CHROME_FOR_TESTING_SHA256"]).toBe(
        "0704631fb3e4f741092e08f55272f90abc3e307f991f05f332924364415b02e0",
      );
      const capturedLinuxOutput = "Google Chrome for Testing 152.0.7977.82 ";
      const checksumFailureEnvironment = join(scratch, "checksum-failure-env");
      const checksumFailure = runBash(provision.run ?? "", {
        ...baseEnvironment,
        FAKE_CHROME_OUTPUT: capturedLinuxOutput,
        FORCE_CHECKSUM_FAILURE: "1",
        GITHUB_ENV: checksumFailureEnvironment,
      });
      expect(checksumFailure.status).not.toBe(0);
      expect(existsSync(checksumFailureEnvironment)).toBe(false);
      expect(existsSync(join(scratch, "chrome-for-testing"))).toBe(false);
      expect(existsSync(join(scratch, "solwyn-verification-chrome"))).toBe(false);

      const missingCheckEnvironment = join(scratch, "missing-check-env");
      const missingCheck = runBash(
        (provision.run ?? "").replace("sha256sum --check", "sha256sum"),
        {
          ...baseEnvironment,
          FAKE_CHROME_OUTPUT: capturedLinuxOutput,
          GITHUB_ENV: missingCheckEnvironment,
        },
      );
      expect(missingCheck.status).not.toBe(0);
      expect(existsSync(missingCheckEnvironment)).toBe(false);

      const success = runBash(provision.run ?? "", {
        ...baseEnvironment,
        FAKE_CHROME_OUTPUT: capturedLinuxOutput,
      });
      expect(success.status, String(success.stderr)).toBe(0);
      expect(success.stdout).toContain(`Pinned Chrome reports: <${capturedLinuxOutput}>`);
      expect(readFileSync(curlRecord, "utf8")).toBe(
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.82/linux64/chrome-linux64.zip",
      );
      expect(readFileSync(chromeSha256Record, "utf8")).toBe(
        `0704631fb3e4f741092e08f55272f90abc3e307f991f05f332924364415b02e0 ${scratch}/chrome-for-testing.zip`,
      );
      expect(readFileSync(githubEnvironment, "utf8")).toBe(
        `SOLWYN_VERIFICATION_BROWSER=${scratch}/solwyn-verification-chrome\n`,
      );
      const browser = spawnSync(
        `${scratch}/solwyn-verification-chrome`,
        ["--headless=new", "about:blank"],
        {
          encoding: "utf8",
          env: { ...process.env, ...baseEnvironment, FAKE_CHROME_OUTPUT: capturedLinuxOutput },
        },
      );
      expect(browser.status).toBe(0);
      expect(readFileSync(browserArgsRecord, "utf8")).toBe(
        "--no-sandbox\n--headless=new\nabout:blank\n",
      );
      const wrongVersionEnvironment = join(scratch, "wrong-version-env");
      const wrongVersion = runBash(provision.run ?? "", {
        ...baseEnvironment,
        FAKE_CHROME_OUTPUT: "Google Chrome for Testing 152.0.7977.81 ",
        GITHUB_ENV: wrongVersionEnvironment,
      });
      expect(wrongVersion.status).not.toBe(0);
      expect(wrongVersion.stdout).toContain(
        "Pinned Chrome reports: <Google Chrome for Testing 152.0.7977.81 >",
      );
      expect(wrongVersion.stderr).toContain(
        "Pinned Chrome version mismatch: expected <152.0.7977.82>, got <152.0.7977.81>",
      );
      expect(existsSync(wrongVersionEnvironment)).toBe(false);

      const malformedEnvironment = join(scratch, "malformed-version-env");
      const malformed = runBash(provision.run ?? "", {
        ...baseEnvironment,
        FAKE_CHROME_OUTPUT: "Google Chrome for Testing unknown ",
        GITHUB_ENV: malformedEnvironment,
      });
      expect(malformed.status).not.toBe(0);
      expect(malformed.stdout).toContain(
        "Pinned Chrome reports: <Google Chrome for Testing unknown >",
      );
      expect(malformed.stderr).toContain(
        "Could not parse the pinned Chrome version from: <Google Chrome for Testing unknown >",
      );
      expect(existsSync(malformedEnvironment)).toBe(false);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  it("uses only the reviewed immutable Node 24 action revisions", async () => {
    expectOnlyReviewedActionPins(await readFile(ciPath, "utf8"));
  });
});

describe("publish workflow contract", () => {
  it("accepts only an exact tag and requires successful CI for the resolved commit", async () => {
    const workflow = await readFile(publishPath, "utf8");
    const release = job(workflow, "verify-release-commit");

    expect(workflow).toMatch(/tags:\s*\["v\*"\]/);
    expect(workflow).toContain("workflow_dispatch:");
    expect(release).toContain(`ref: \${{ github.sha }}`);
    expect(release).toContain('test "$RELEASE_TAG" = "v$MANIFEST_VERSION"');
    expect(release).toContain('test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"');
    expect(release).toContain('test "$GITHUB_SHA" = "$RELEASE_COMMIT"');
    expect(release).toContain('git rev-parse "$RELEASE_TAG^{commit}"');
    expect(release).toContain("actions/workflows/ci.yml/runs?head_sha=");
    expect(release).toContain("run.head_sha === releaseCommit");
    expect(release).toContain('run.conclusion === "success"');
    expect(release).toContain("cannot bootstrap a package");
  });

  it("serializes every package and channel release in one non-cancelling group", async () => {
    const { model } = await parseWorkflow(publishPath);

    expect(model.concurrency).toEqual({
      group: "npm-publish-solwyn-sdk",
      "cancel-in-progress": false,
    });
  });

  it("executes the complete successful-CI authorization predicate", async () => {
    const { model } = await parseWorkflow(publishPath);
    const authorization = namedStep(
      semanticJob(model, "verify-release-commit"),
      "Require a successful complete CI run for this commit",
    );
    const predicate = nodeHeredoc(authorization.run ?? "");
    const releaseCommit = "a".repeat(40);
    const valid = {
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: releaseCommit,
    };
    const cases = [
      ["valid", [valid], 0],
      ["wrong SHA", [{ ...valid, head_sha: "b".repeat(40) }], 1],
      ["wrong branch", [{ ...valid, head_branch: "release" }], 1],
      ["wrong event", [{ ...valid, event: "pull_request" }], 1],
      ["wrong conclusion", [{ ...valid, conclusion: "failure" }], 1],
      [
        "conditions split across runs",
        [
          { ...valid, event: "pull_request" },
          { ...valid, head_sha: "b".repeat(40) },
        ],
        1,
      ],
    ] as const;
    const scratch = mkdtempSync(join(tmpdir(), "workflow-ci-authorization-"));
    try {
      for (const [name, runs, expectedStatus] of cases) {
        writeFileSync(join(scratch, "ci-runs.json"), JSON.stringify([{ workflow_runs: runs }]));
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", predicate], {
          encoding: "utf8",
          env: { ...process.env, RELEASE_COMMIT: releaseCommit, RUNNER_TEMP: scratch },
        });
        expect(result.status, `${name}: ${result.stderr}`).toBe(expectedStatus);
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  it("packs one artifact and makes both Node verification lanes consume it", async () => {
    const workflow = await readFile(publishPath, "utf8");
    const artifact = job(workflow, "build-release-artifact");
    const consumers = job(workflow, "verify-release-artifact");

    expect(workflow.match(/ARTIFACT_DIR: \$\{\{ github\.workspace \}\}-artifact/g)).toHaveLength(3);
    expect(workflow).not.toContain("../release-artifact");
    expect(workflow.match(/release-artifact\.mjs create/g)).toHaveLength(1);
    expect(workflow.match(/release-artifact\.mjs verify-directory/g)).toHaveLength(3);
    expect(workflow).not.toContain('find "$ARTIFACT_DIR"');
    expectCommandsInOrder(artifact, [
      "pnpm build",
      "release-artifact.mjs create",
      "release-artifact.mjs verify-directory",
      "pnpm check:public --artifact-dir",
      "actions/upload-artifact@",
    ]);
    expect(consumers).toContain('node-version: ["22.23.2", "24.21.0"]');
    expect(consumers).toContain(`ref: \${{ needs.verify-release-commit.outputs.release-commit }}`);
    expectCommandsInOrder(consumers, [
      'test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"',
      "pnpm install --frozen-lockfile",
    ]);
    expect(consumers).toContain("152.0.7977.82");
    expectCommandsInOrder(consumers, [
      "actions/download-artifact@",
      "release-artifact.mjs verify-directory",
      "pnpm test:pack -- --tarball",
      "pnpm test:consumers -- --tarball",
    ]);
    expect(consumers).not.toMatch(/\b(?:npm pack|pnpm build|release-artifact\.mjs create)\b/);
  });

  it("gives OIDC only to the protected publish job and never uses a token fallback", async () => {
    const { model, source: workflow } = await parseWorkflow(publishPath);
    const publishJob = semanticJob(model, "publish-npm");
    const publish = job(workflow, "publish-npm");

    expect(workflow).toMatch(/^permissions:\n {2}actions: read\n {2}contents: read$/m);
    expect(workflow.match(/id-token:\s*write/g)).toHaveLength(1);
    expect(publishJob.needs).toEqual([
      "verify-release-commit",
      "build-release-artifact",
      "verify-release-artifact",
    ]);
    expect(publishJob.if).toBe("vars.NPM_TRUSTED_PUBLISHING_ENABLED == 'true'");
    expect(environmentName(publishJob)).toBe("npm-publish");
    expect(publishJob.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(publish).toContain("if: vars.NPM_TRUSTED_PUBLISHING_ENABLED == 'true'");
    expect(publish).toContain("environment: npm-publish");
    expect(publish).toContain("runs-on: ubuntu-24.04");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("actions/download-artifact@");
    expect(publish).toContain("release-artifact.mjs verify-directory");
    expect(publish).not.toMatch(/\b(?:npm pack|pnpm build|release-artifact\.mjs create)\b/);
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm_[A-Za-z0-9]{20,}/i);
  });

  it.each([
    ["1.2.3", "latest"],
    ["1.2.3-rc.1", "next"],
    ["2.0.0-beta.2", "next"],
  ])("publishes %s to %s from a neutral npm environment", async (version, tag) => {
    const { model } = await parseWorkflow(publishPath);
    const publish = namedStep(
      semanticJob(model, "publish-npm"),
      "Publish the verified bytes with trusted publishing",
    );
    const execution = executePublishStep(publish.run ?? "", {
      publishConfig: { access: "public" },
      version,
    });
    try {
      expect(execution.negativeControl.status, execution.negativeControl.stderr).toBe(0);
      expect(execution.negativeControl.stdout.trim()).toBe("false");
      expect(execution.result.status, String(execution.result.stderr)).toBe(0);
      const record = JSON.parse(execution.publishRecord) as {
        readonly args: readonly string[];
        readonly cwd: string;
        readonly globalConfig: string;
        readonly globalConfigText: string;
        readonly nodeExtraCaCerts?: string;
        readonly nodeTlsRejectUnauthorized?: string;
        readonly npmConfigEnvironment: Readonly<Record<string, string>>;
        readonly proxyEnvironment: Readonly<Record<string, string>>;
        readonly userConfig: string;
        readonly userConfigText: string;
      };
      expect(record.cwd).not.toBe(execution.hostileProject);
      expect(record.cwd).toContain(
        `/${execution.scratch.slice(execution.scratch.lastIndexOf("/") + 1)}/npm-publish.`,
      );
      const configuredCwd = record.cwd.replace(/^\/private(?=\/var\/)/, "");
      expect(record.userConfig).toBe(`${configuredCwd}/user.npmrc`);
      expect(record.globalConfig).toBe(`${configuredCwd}/global.npmrc`);
      expect(record.userConfigText).toBe("");
      expect(record.globalConfigText).toBe("");
      expect(record.proxyEnvironment).toEqual({});
      expect(record.npmConfigEnvironment).toEqual({});
      expect(record.nodeExtraCaCerts).toBeUndefined();
      expect(record.nodeTlsRejectUnauthorized).toBeUndefined();
      expect(record.args[0]).toBe("publish");
      expect(record.args[1]).toBe(execution.tarball);
      expect(record.args).toContain(`--tag=${tag}`);
      expect(record.args).toContain("--registry=https://registry.npmjs.org");
      expect(record.args).toContain("--@solwyn:registry=https://registry.npmjs.org");
      expect(record.args).toContain("--strict-ssl=true");
      expect(record.args).toContain("--dry-run=false");
      expect(record.args).toContain("--ignore-scripts=true");
      expect(record.args).toContain("--access=public");
      expect(record.args).toContain("--provenance=true");
    } finally {
      rmSync(execution.scratch, { force: true, recursive: true });
    }
  });

  it.each([
    "registry",
    "@solwyn:registry",
    "proxy",
    "https-proxy",
    "strict-ssl",
    "cafile",
    "ca",
    "dry-run",
    "ignore-scripts",
    "access",
    "provenance",
  ])("fails closed when effective npm %s configuration is unsafe", async (setting) => {
    const { model } = await parseWorkflow(publishPath);
    const publish = namedStep(
      semanticJob(model, "publish-npm"),
      "Publish the verified bytes with trusted publishing",
    );
    const execution = executePublishStep(publish.run ?? "", {
      publishConfig: { access: "public" },
      sabotageConfig: setting,
      version: "1.2.3",
    });
    try {
      expect(execution.result.status, `${setting} must fail closed`).not.toBe(0);
      expect(execution.publishRecord).toBe("");
    } finally {
      rmSync(execution.scratch, { force: true, recursive: true });
    }
  });

  it("rejects a tarball publishConfig with any unreviewed key", async () => {
    const { model } = await parseWorkflow(publishPath);
    const publish = namedStep(
      semanticJob(model, "publish-npm"),
      "Publish the verified bytes with trusted publishing",
    );
    const execution = executePublishStep(publish.run ?? "", {
      publishConfig: { access: "public", registry: "https://registry.attacker.invalid/" },
      version: "1.2.3",
    });
    try {
      expect(execution.result.status).not.toBe(0);
      expect(execution.publishRecord).toBe("");
    } finally {
      rmSync(execution.scratch, { force: true, recursive: true });
    }
  });

  it.each([
    ["stable advance", "1.0.1", { latest: "1.0.0", next: "1.1.0-rc.1" }, [], 0],
    ["stable equality", "1.0.0", { latest: "1.0.0", next: "1.1.0-rc.1" }, [], 1],
    ["stable rollback", "0.9.9", { latest: "1.0.0", next: "1.1.0-rc.1" }, [], 1],
    ["prerelease advance", "1.1.0-rc.2", { latest: "1.0.0", next: "1.1.0-rc.1" }, [], 0],
    [
      "prerelease channel rollback",
      "1.1.0-alpha.1",
      { latest: "1.0.0", next: "1.1.0-rc.1" },
      [],
      1,
    ],
    ["prerelease stable rollback", "0.9.1-rc.1", { latest: "1.0.0", next: "0.9.0-rc.1" }, [], 1],
    ["first stable", "1.0.0", { next: "1.0.0-rc.1" }, [], 0],
    ["first next after stable", "1.1.0-rc.1", { latest: "1.0.0" }, [], 0],
    ["version already present", "1.1.0", { latest: "1.0.0", next: "1.1.0-rc.1" }, ["1.1.0"], 1],
    ["malformed current tag", "1.1.0", { latest: "not-semver" }, [], 1],
  ])("rejects version reuse and dist-tag rollback: %s", async (_name, candidate, distTags, extraVersions, expectedStatus) => {
    const { model } = await parseWorkflow(publishPath);
    const guard = namedStep(
      semanticJob(model, "publish-npm"),
      "Reject version reuse and dist-tag rollback",
    );
    const script = nodeHeredoc(guard.run ?? "");
    expect(script).toContain('from "./scripts/release-policy.mjs"');
    expect(script).not.toContain("function compareVersions");
    const scratch = mkdtempSync(join(tmpdir(), "workflow-dist-tag-"));
    const packumentFile = join(scratch, "packument.json");
    const versions = Object.fromEntries(
      [...Object.values(distTags), ...extraVersions].map((version) => [version, {}]),
    );
    writeFileSync(
      packumentFile,
      JSON.stringify({ name: "@solwyn/sdk", "dist-tags": distTags, versions }),
    );
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_VERSION: candidate,
          PACKUMENT_FILE: packumentFile,
        },
      });
      expect(result.status, result.stderr).toBe(expectedStatus);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  it.each([
    ["11.5.0", 1],
    ["11.5.1", 0],
    ["11.19.0", 0],
    ["12.0.0", 0],
    ["10.99.99", 1],
    ["11.5.1-pre.0", 1],
    ["not-a-version", 1],
  ])("enforces the complete npm 11.5.1 trusted-publishing floor for %s", async (version, status) => {
    const publish = job(await readFile(publishPath, "utf8"), "publish-npm");
    const gate = publish.match(/node -e '([^']+)' "\$npm_version"/)?.[1];

    expect(gate, "missing executable npm version gate").toBeDefined();
    expect(spawnSync(process.execPath, ["-e", gate ?? "", version]).status).toBe(status);
  });

  it("uses only the reviewed immutable Node 24 action revisions", async () => {
    expectOnlyReviewedActionPins(await readFile(publishPath, "utf8"));
  });
});
