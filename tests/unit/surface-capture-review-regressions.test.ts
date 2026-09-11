import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { SurfaceObservation } from "../../src/surface-graph";
import { createSurfaceRules, type SurfaceContext } from "../../src/surfaces";
import * as surfaceAudit from "../helpers/surface-audit";

const OPENAI: SurfaceContext = {
  provider: "openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};

const TOGETHER_NATIVE: SurfaceContext = {
  provider: "together",
  dialect: "openai",
  clientShape: "native_together",
};

const execFileAsync = promisify(execFile);

function encodedRows(observations: readonly SurfaceObservation[]): surfaceAudit.BaselineRow[] {
  return observations.map((observation) => [
    observation.path,
    [`${observation.descriptorCategory}:${observation.returnShape}`],
  ]);
}

function captureCanaryError(run: () => unknown): surfaceAudit.SurfaceCanaryError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(surfaceAudit.SurfaceCanaryError);
    return error as surfaceAudit.SurfaceCanaryError;
  }
  throw new Error("expected surface canary to fail");
}

describe("reviewed surface frontier", () => {
  it("audits an unknown operation below a baseline-reviewed field resource", () => {
    class BatchesResource {
      create(): void {}
    }

    const error = captureCanaryError(() =>
      surfaceAudit.auditPublicSurface(
        { batches: new BatchesResource() },
        {
          context: OPENAI,
          clientFamily: "fake-openai",
          installedVersion: "1.2.3",
          baselineRows: [["batches", ["field:resource"]]],
        },
      ),
    );

    expect(error).toMatchObject({
      path: "batches.create",
      stage: "unknown_classification",
    });
  });

  it("discovers safe field resources to a stable frontier in the first pass", () => {
    class BatchesResource {
      create(): void {}
    }
    let unreviewedGetterEvaluations = 0;
    const root = {
      batches: new BatchesResource(),
      get secrets(): object {
        unreviewedGetterEvaluations += 1;
        return {};
      },
    };

    const first = surfaceAudit.observeReviewedPublicSurface(root, {
      context: OPENAI,
      baselineRows: [],
    });

    expect(first.namespaces).toContain("batches");
    expect(first.namespaces).not.toContain("secrets");
    expect(first.observations).toEqual([
      { path: "batches", descriptorCategory: "field", returnShape: "resource" },
      { path: "batches.create", descriptorCategory: "method", returnShape: "function" },
      {
        path: "secrets",
        descriptorCategory: "getter",
        returnShape: "unevaluated_accessor",
      },
    ]);
    expect(unreviewedGetterEvaluations).toBe(0);

    const next = surfaceAudit.observeReviewedPublicSurface(root, {
      context: OPENAI,
      baselineRows: encodedRows(first.observations),
    });
    expect(next).toEqual(first);
    expect(unreviewedGetterEvaluations).toBe(0);
  });

  it("does not reopen terminal infrastructure through descendant baseline rows", () => {
    class LoggerChildResource {
      ping(): void {}
    }

    class LoggerResource {
      readonly child = new LoggerChildResource();

      log(): void {}
    }

    const reviewed = surfaceAudit.observeReviewedPublicSurface(
      { logger: new LoggerResource() },
      {
        context: OPENAI,
        baselineRows: [
          ["logger", ["field:resource"]],
          ["logger.child", ["field:resource"]],
        ],
      },
    );

    expect(reviewed.namespaces).not.toContain("logger");
    expect(reviewed.namespaces).not.toContain("logger.child");
    expect(reviewed.observations).toEqual([
      { path: "logger", descriptorCategory: "field", returnShape: "resource" },
    ]);
  });

  it("preserves explicitly curated descendants below infrastructure resources", () => {
    class LoggerChildResource {
      flush(): void {}
    }

    class LoggerResource {
      readonly child = new LoggerChildResource();
    }

    const selector = [
      { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
    ] as const;
    const rules = createSurfaceRules([
      {
        ruleId: "surface.logger.infrastructure",
        surface: "logger",
        selectors: selector,
        kind: "infrastructure",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "field", returnShape: "resource" }],
      },
      {
        ruleId: "surface.logger-child.namespace",
        surface: "logger.child",
        selectors: selector,
        kind: "namespace",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "field", returnShape: "resource" }],
      },
      {
        ruleId: "surface.logger-child-flush.metered",
        surface: "logger.child.flush",
        selectors: selector,
        kind: "metered",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        usageBasis: "provider",
      },
    ]);

    const reviewed = surfaceAudit.observeReviewedPublicSurface(
      { logger: new LoggerResource() },
      {
        context: OPENAI,
        baselineRows: [],
        rules,
      },
    );

    expect(reviewed.namespaces).toEqual(["logger", "logger.child"]);
    expect(reviewed.observations).toEqual([
      { path: "logger", descriptorCategory: "field", returnShape: "resource" },
      { path: "logger.child", descriptorCategory: "field", returnShape: "resource" },
      {
        path: "logger.child.flush",
        descriptorCategory: "method",
        returnShape: "function",
      },
    ]);
  });

  it("recursively reviews non-infrastructure resource rules", () => {
    class SessionsResource {
      list(): void {}
    }

    class CodeInterpreterResource {
      readonly sessions = new SessionsResource();

      execute(): void {}
    }

    const reviewed = surfaceAudit.observeReviewedPublicSurface(
      { codeInterpreter: new CodeInterpreterResource() },
      {
        context: TOGETHER_NATIVE,
        baselineRows: [],
      },
    );

    expect(reviewed.namespaces).toEqual([
      "audio",
      "audio.speech",
      "audio.transcriptions",
      "chat",
      "chat.completions",
      "codeInterpreter",
      "codeInterpreter.sessions",
      "embeddings",
      "images",
    ]);
    expect(reviewed.observations).toEqual([
      {
        path: "codeInterpreter",
        descriptorCategory: "field",
        returnShape: "resource",
      },
      {
        path: "codeInterpreter.execute",
        descriptorCategory: "method",
        returnShape: "function",
      },
      {
        path: "codeInterpreter.sessions",
        descriptorCategory: "field",
        returnShape: "resource",
      },
      {
        path: "codeInterpreter.sessions.list",
        descriptorCategory: "method",
        returnShape: "function",
      },
    ]);
  });

  it("does not force a mixed-version callable baseline shape to be a namespace", () => {
    const reviewed = surfaceAudit.observeReviewedPublicSurface(
      { rerank: () => undefined },
      {
        context: TOGETHER_NATIVE,
        baselineRows: [["rerank", ["field:resource", "method:function"]]],
      },
    );

    expect(reviewed.namespaces).not.toContain("rerank");
    expect(reviewed.observations).toEqual([
      { path: "rerank", descriptorCategory: "method", returnShape: "function" },
    ]);
  });
});

describe("capture orchestration", () => {
  it("installs the terminal network guard before invoking the provider importer", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "solwyn-guard-order-"));
    const captureScriptUrl = new URL("../../scripts/capture-surface-inventory.ts", import.meta.url)
      .href;
    const proofSource = `
      const { executeCapture } = await import(${JSON.stringify(captureScriptUrl)});
      let importerReached = false;
      try {
        await executeCapture(
          {
            interval: "latest",
            family: "google-generativeai",
            mode: "check",
            outputDir: ${JSON.stringify(outputDirectory)},
          },
          {
            importFamily: async () => {
              importerReached = true;
              try {
                await globalThis.fetch("https://surface-guard-order.invalid");
              } catch (error) {
                if (error instanceof Error && error.name === "OfflineViolationError") {
                  process.stdout.write("guard-active\\n");
                  throw new Error("guard-order-proof-complete");
                }
                throw error;
              }
              throw new Error("network guard was not active");
            },
          },
        );
      } catch (error) {
        if (error instanceof Error && error.message === "guard-order-proof-complete") {
          process.exit(0);
        }
        throw error;
      }
      if (!importerReached) {
        throw new Error("capture importer seam was not invoked");
      }
    `;

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", proofSource],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect({ stdout, stderr }).toEqual({
        stdout: "guard-active\n",
        stderr: "",
      });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      scenario: "mandatory fetch",
      entryPoint: "fetch",
      prelude: `
        Object.defineProperty(globalThis, "fetch", {
          value: globalThis.fetch,
          writable: false,
          configurable: false,
        });
      `,
    },
    {
      scenario: "runtime-present optional connectAsync",
      entryPoint: "net.connectAsync",
      prelude: `
        const net = (await import("node:net")).default;
        Object.defineProperty(net, "connectAsync", {
          value: () => undefined,
          writable: false,
          configurable: false,
        });
      `,
    },
  ])("fails before provider import when $scenario cannot be patched", async ({
    entryPoint,
    prelude,
  }) => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "solwyn-guard-installation-"));
    const captureScriptUrl = new URL("../../scripts/capture-surface-inventory.ts", import.meta.url)
      .href;
    const proofSource = `
      ${prelude}
      const { executeCapture } = await import(${JSON.stringify(captureScriptUrl)});
      let importerReached = false;
      let outcome;
      try {
        await executeCapture(
          {
            interval: "latest",
            family: "google-generativeai",
            mode: "check",
            outputDir: ${JSON.stringify(outputDirectory)},
          },
          {
            importFamily: async () => {
              importerReached = true;
              throw new Error("provider importer reached");
            },
          },
        );
      } catch (error) {
        outcome = {
          importerReached,
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      process.stdout.write(JSON.stringify(outcome));
    `;

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", proofSource],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect({ outcome: JSON.parse(stdout), stderr }).toEqual({
        outcome: {
          importerReached: false,
          name: "OfflineGuardInstallationError",
          message: `offline guard could not replace network entry point: ${entryPoint}`,
        },
        stderr: "",
      });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
