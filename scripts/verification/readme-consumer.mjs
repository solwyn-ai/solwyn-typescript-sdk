/** Side-effect-free extraction of the installed README's Vercel AI SDK consumer recipe. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const readmeAiLockedVersions = Object.freeze({
  ai: "7.0.14",
  "@ai-sdk/openai": "4.0.65",
});

function section(source) {
  const match = /^## Vercel AI SDK\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(source);
  assert.ok(match, "README must contain one Vercel AI SDK section");
  return match[1];
}

function fences(source, language) {
  const pattern = new RegExp(`^${"```"}${language}\\s*\\r?\\n([\\s\\S]*?)^${"```"}\\s*$`, "gm");
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

export function resolveReadmeAiPackages(packageNames, lockedVersions) {
  assert.deepEqual(
    [...packageNames].sort(),
    Object.keys(lockedVersions).sort(),
    "README AI install packages must equal the locked package set",
  );
  return packageNames.map((name) => {
    const version = lockedVersions[name];
    assert.equal(typeof version, "string");
    return { name, version, spec: `${name}@${version}` };
  });
}

export function assertReadmeAiConsumerChecks(checks) {
  assert.deepEqual(Object.keys(checks).sort(), [
    "developmentDependencies",
    "installCommand",
    "installedPackages",
    "lib",
    "packageNames",
    "packageSpecs",
    "runtimeDependencies",
    "skipLibCheck",
    "sourceSha256",
    "strict",
    "types",
  ]);
  const packages = resolveReadmeAiPackages(checks.packageNames, readmeAiLockedVersions);
  assert.equal(checks.installCommand, `npm install ${checks.packageNames.join(" ")}`);
  assert.deepEqual(checks.runtimeDependencies, ["@solwyn/sdk", ...checks.packageNames].sort());
  assert.deepEqual(checks.developmentDependencies, [
    "@types/json-schema",
    "@types/node",
    "typescript",
  ]);
  assert.deepEqual(
    checks.packageSpecs,
    packages.map(({ spec }) => spec),
  );
  assert.deepEqual(
    checks.installedPackages,
    Object.fromEntries(packages.map(({ name, version }) => [name, version])),
  );
  assert.match(checks.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(checks.strict, true);
  assert.equal(checks.skipLibCheck, false);
  assert.deepEqual(checks.types, ["node"]);
  assert.deepEqual(checks.lib, ["ES2023", "DOM", "ESNext.Disposable"]);
}

export function extractReadmeAiConsumer(readme) {
  assert.equal(typeof readme, "string");
  const aiSection = section(readme);
  const shellFences = fences(aiSection, "(?:sh|bash)");
  assert.equal(shellFences.length, 1, "Vercel AI SDK section must contain one install fence");
  const commands = shellFences[0]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(commands.length, 1, "Vercel AI SDK install fence must contain one command");
  const command = /^npm install (\S+(?:\s+\S+)*)$/.exec(commands[0]);
  assert.ok(command, "Vercel AI SDK install fence must use npm install with package specs");
  const packageNames = command[1].split(/\s+/);
  for (const name of packageNames)
    assert.match(name, packageName, `Invalid README install package name: ${name}`);
  assert.equal(
    new Set(packageNames).size,
    packageNames.length,
    "Vercel AI SDK install fence contains a duplicate package",
  );

  const typeScriptFences = fences(aiSection, "(?:ts|typescript)");
  assert.equal(
    typeScriptFences.length,
    1,
    "Vercel AI SDK section must contain one TypeScript fence",
  );
  const source = `${typeScriptFences[0].replace(/\r\n/g, "\n").trim()}\n`;
  return {
    installCommand: commands[0],
    packageNames,
    source,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  };
}
