/**
 * Distribution guard: the BUILT package never loads OpenTelemetry.
 *
 * Trace correlation reads `@opentelemetry/api`'s process-global registry structurally, so
 * the SDK must not import, require, or register OpenTelemetry itself — not even though the
 * real packages are installed here as devDependencies and would resolve if referenced.
 *
 * For every public entry (ESM and CJS), a plain `node` subprocess installs a synchronous
 * module resolution hook (`module.registerHooks`, which observes both `import` and
 * `require`), loads the entry, and reports every resolved module URL plus the state of the
 * `Symbol.for("opentelemetry.js.api.1")` registry slot. A positive control proves the hook
 * does see an `@opentelemetry/*` load when one happens.
 *
 * Requires a prior `pnpm build`; run via `pnpm test:dist`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const ENTRIES = [
  "index.js",
  "index.cjs",
  "node.js",
  "node.cjs",
  "ai-sdk/index.js",
  "ai-sdk/index.cjs",
  "testing/index.js",
  "testing/index.cjs",
] as const;

const PROBE = `
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const [entry, format] = process.argv.slice(1);
const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved.push(result.url);
    return result;
  },
});
const require = createRequire(entry);
const loaded = format === "cjs" ? require(entry) : await import(pathToFileURL(entry).href);
process.stdout.write(
  JSON.stringify({
    exportCount: Object.keys(loaded).length,
    resolved,
    requireCache: Object.keys(require.cache),
    registryType: typeof globalThis[Symbol.for("opentelemetry.js.api.1")],
  }),
);
`;

interface ProbeResult {
  readonly exportCount: number;
  readonly resolved: readonly string[];
  readonly requireCache: readonly string[];
  readonly registryType: string;
}

async function probe(entry: string, format: "esm" | "cjs"): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", PROBE, entry, format],
    { timeout: 30_000 },
  );
  return JSON.parse(stdout.trim()) as ProbeResult;
}

function distPath(entry: string): string {
  return fileURLToPath(new URL(`../../dist/${entry}`, import.meta.url));
}

function openTelemetryModules(result: ProbeResult): string[] {
  return [...result.resolved, ...result.requireCache].filter((url) =>
    url.includes("@opentelemetry"),
  );
}

describe("dist entries load without OpenTelemetry", () => {
  it.each(
    ENTRIES,
  )("importing dist/%s loads no @opentelemetry module and leaves the registry unset", async (entry) => {
    const path = distPath(entry);
    if (!existsSync(path)) {
      throw new Error(`dist/${entry} is missing — run \`pnpm build\` before \`pnpm test:dist\`.`);
    }
    const result = await probe(path, entry.endsWith(".cjs") ? "cjs" : "esm");

    expect(result.exportCount).toBeGreaterThan(0);
    // The hook really observed the entry's own module graph.
    expect(result.resolved.some((url) => url.includes("/dist/"))).toBe(true);
    expect(openTelemetryModules(result)).toEqual([]);
    expect(result.registryType).toBe("undefined");
  });

  it.each([
    "esm",
    "cjs",
  ] as const)("positive control: the probe detects a real @opentelemetry/api load (%s)", async (format) => {
    const api = createRequire(import.meta.url).resolve("@opentelemetry/api");
    const result = await probe(api, format);

    expect(openTelemetryModules(result).length).toBeGreaterThan(0);
  });
});
