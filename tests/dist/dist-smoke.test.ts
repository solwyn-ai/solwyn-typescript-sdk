/**
 * Distribution smoke test for dynamically loaded provider adapters.
 *
 * The adapter registry pulls concrete adapter modules in via dynamic `import()`. If the
 * import specifier is a runtime VARIABLE, tsup/esbuild cannot rewrite it to the emitted
 * chunk, so the PUBLISHED artifact throws `ERR_MODULE_NOT_FOUND` (`dist/openai`) on the
 * first intercepted call — in BOTH the ESM and CJS builds. The unit suite never catches
 * this because vitest resolves the extensionless specifier against `src/`.
 *
 * This test exercises the BUILT output the way a real consumer's Node would: it spawns a
 * plain `node` subprocess (no vitest/vite module resolution in the path) that dynamically
 * imports `dist/index.js` (ESM) and `dist/index.cjs` (CJS), constructs a `Solwyn` around a
 * provider-SDK-free fake OpenAI client, and performs one intercepted `create()` call. It
 * asserts the call dispatches (no module-resolution error) and that the openai adapter
 * chunk is loaded lazily only on first use, not at import or construction.
 *
 * Requires a prior `pnpm build`; it is excluded from the default vitest glob and run via
 * `pnpm test:dist` (wired into CI after `pnpm build`). See `fixtures/harness.mjs`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const harness = fileURLToPath(new URL("./fixtures/harness.mjs", import.meta.url));
const aiSdkHarness = fileURLToPath(new URL("./fixtures/ai-sdk-harness.mjs", import.meta.url));
const surfaceSharingHarness = fileURLToPath(
  new URL("./fixtures/surface-sharing-harness.mjs", import.meta.url),
);
const esmEntry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const cjsEntry = fileURLToPath(new URL("../../dist/index.cjs", import.meta.url));
const aiSdkEsmEntry = fileURLToPath(new URL("../../dist/ai-sdk/index.js", import.meta.url));
const aiSdkCjsEntry = fileURLToPath(new URL("../../dist/ai-sdk/index.cjs", import.meta.url));

interface HarnessResult {
  dispatched: boolean;
  loadedBeforeCall: string[];
  loadedAfterCall: string[];
}

interface AiSdkHarnessResult {
  loaded: boolean;
  hasWrapGenerate: boolean;
  hasWrapStream: boolean;
  hasClose: boolean;
  hasDispose: boolean;
}

interface ErrorEntry {
  readonly BudgetExceededError: new (...args: never[]) => Error;
  readonly RunStoppedError: new (options: {
    agentRunId: string;
    reason: string;
    source: "server" | "local_velocity";
  }) => Error;
  readonly SolwynError: new (...args: never[]) => Error;
}

async function runHarness(entry: string): Promise<HarnessResult> {
  const { stdout } = await execFileAsync(process.execPath, [harness, entry], {
    timeout: 30_000,
  });
  return JSON.parse(stdout.trim()) as HarnessResult;
}

async function runAiSdkHarness(entry: string): Promise<AiSdkHarnessResult> {
  const { stdout } = await execFileAsync(process.execPath, [aiSdkHarness, entry], {
    timeout: 30_000,
  });
  return JSON.parse(stdout.trim()) as AiSdkHarnessResult;
}

describe("dist smoke — built artifact loads the openai adapter", () => {
  beforeAll(() => {
    if (!existsSync(esmEntry) || !existsSync(cjsEntry)) {
      throw new Error(
        "dist build missing — run `pnpm build` before `pnpm test:dist` (both are wired in CI).",
      );
    }
  });

  it("dispatches an intercepted create() through the ESM build (no ERR_MODULE_NOT_FOUND)", async () => {
    const result = await runHarness(esmEntry);
    expect(result.dispatched).toBe(true);
    // The code-split OpenAI chunk loads on first use, not before.
    expect(result.loadedBeforeCall).toEqual([]);
    expect(result.loadedAfterCall).toHaveLength(1);
    expect(result.loadedAfterCall[0]).toMatch(/\/openai-[A-Z0-9]+\.js$/);
  });

  it("dispatches an intercepted create() through the CJS build (no ERR_MODULE_NOT_FOUND)", async () => {
    const result = await runHarness(cjsEntry);
    expect(result.dispatched).toBe(true);
    // esbuild still emits a resolvable, lazily-imported chunk for the CJS build.
    expect(result.loadedBeforeCall).toEqual([]);
    expect(result.loadedAfterCall).toHaveLength(1);
    expect(result.loadedAfterCall[0]).toMatch(/\/openai-[A-Z0-9]+\.cjs$/);
  });
});

describe("dist smoke — built stopped-run error contract", () => {
  it("shares process-wide surface counts, warnings and capacity across real ESM and CJS entries", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [surfaceSharingHarness, esmEntry, cjsEntry],
      {
        timeout: 30_000,
      },
    );
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({
      combinedCount: 2,
      sharedWarnings: 1,
      registrySize: 512,
      totalWarnings: 513,
      retainedEsmOnly: true,
      retainedCjsOnly: false,
      meteringCalls: 0,
    });
    expect(result.esmSurfaces).toContain("futureShared");
    expect(result.cjsSurfaces).toContain("futureShared");
    expect(result.esmSurfaces).toContain("futureEsmOnly");
    expect(result.esmSurfaces).not.toContain("futureCjsOnly");
    expect(result.cjsSurfaces).toContain("futureCjsOnly");
    expect(result.cjsSurfaces).not.toContain("futureEsmOnly");
    expect(result.esmInstanceIds).toHaveLength(1);
    expect(result.cjsInstanceIds).toHaveLength(1);
    expect(result.esmInstanceIds[0]).not.toBe(result.cjsInstanceIds[0]);
  });

  it.each([
    ["ESM", esmEntry],
    ["CJS", cjsEntry],
  ])("exports the direct stopped-run error through the %s build", async (_format, entry) => {
    const built = (await import(pathToFileURL(entry).href)) as ErrorEntry;
    const error = new built.RunStoppedError({
      agentRunId: "run_dist",
      reason: "server_stop",
      source: "server",
    });

    expect(error).toBeInstanceOf(built.RunStoppedError);
    expect(error).toBeInstanceOf(built.SolwynError);
    expect(error).not.toBeInstanceOf(built.BudgetExceededError);
    expect(error.name).toBe("RunStoppedError");
    expect(error.message).toBe("Agent run run_dist was stopped (server: server_stop)");
    expect(error).toMatchObject({
      agentRunId: "run_dist",
      reason: "server_stop",
      source: "server",
    });
    expect(Object.keys(error).filter((key) => key !== "name")).toEqual([
      "agentRunId",
      "reason",
      "source",
    ]);
    expect(built).not.toHaveProperty("RunTerminatedError");
  });
});

describe("dist smoke — built ./ai-sdk entry resolves its code-split chunks", () => {
  beforeAll(() => {
    if (!existsSync(aiSdkEsmEntry) || !existsSync(aiSdkCjsEntry)) {
      throw new Error(
        "dist ai-sdk build missing — run `pnpm build` before `pnpm test:dist` (both are wired in CI).",
      );
    }
  });

  // The ESM `dist/ai-sdk/index.js` statically imports five sibling `../chunk-*.js` files; a
  // future tsup/splitting change could break those specifiers in the PUBLISHED layout without
  // the unit suite (which resolves against `src/`) noticing. These load the built entry the
  // way a consumer's Node would and construct the middleware to prove the chunks resolve.

  it("constructs the middleware through the ESM build", async () => {
    const result = await runAiSdkHarness(aiSdkEsmEntry);
    expect(result.loaded).toBe(true);
    expect(result.hasWrapGenerate).toBe(true);
    expect(result.hasWrapStream).toBe(true);
    expect(result.hasClose).toBe(true);
    expect(result.hasDispose).toBe(true);
  });

  it("constructs the middleware through the CJS build", async () => {
    const result = await runAiSdkHarness(aiSdkCjsEntry);
    expect(result.loaded).toBe(true);
    expect(result.hasWrapGenerate).toBe(true);
    expect(result.hasWrapStream).toBe(true);
    expect(result.hasClose).toBe(true);
    expect(result.hasDispose).toBe(true);
  });
});
