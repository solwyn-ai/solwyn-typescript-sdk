import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type CoverageAuditEntry as DirectCoverageAuditEntry,
  type CoverageEntry as DirectCoverageEntry,
  type CoverageExpectation as DirectCoverageExpectation,
  type CoverageFingerprint as DirectCoverageFingerprint,
  type CoverageReport as DirectCoverageReport,
  type CoverageRuntime as DirectCoverageRuntime,
  coverage as directCoverage,
} from "../../src/coverage.js";
import {
  CoverageMismatchError as DirectCoverageMismatchError,
  UntrackedSpendSurfaceError as DirectUntrackedSpendSurfaceError,
} from "../../src/errors.js";
import type {
  CoverageAuditEntry,
  CoverageEntry,
  CoverageExpectation,
  CoverageFingerprint,
  CoverageReport,
  CoverageRuntime,
  MediaUsage,
  Modality,
} from "../../src/index.js";
import * as publicApi from "../../src/index.js";
import { MODALITIES, VERSION } from "../../src/index.js";
import { SurfaceInspectionError as DirectSurfaceInspectionError } from "../../src/surface-graph.js";

const PACKAGE_JSON = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  readonly version: string;
};
const CHANGELOG = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
const RELEASE_POLICY = new URL("../../scripts/release-policy.mjs", import.meta.url).href;

function releaseChannel(version: string): string {
  const program = `import {releaseChannel} from ${JSON.stringify(RELEASE_POLICY)};process.stdout.write(releaseChannel(${JSON.stringify(version)}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("package smoke", () => {
  it("exports the canonical publishable version declared by the package and changelog", () => {
    expect(["latest", "next"]).toContain(releaseChannel(PACKAGE_JSON.version));
    expect(VERSION).toBe(PACKAGE_JSON.version);

    const unreleasedIndex = CHANGELOG.indexOf("## [Unreleased]");
    const releaseIndex = CHANGELOG.search(
      new RegExp(
        `^## \\[${PACKAGE_JSON.version.replaceAll(".", "\\.")}\\] — \\d{4}-\\d{2}-\\d{2}$`,
        "m",
      ),
    );
    expect(unreleasedIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(unreleasedIndex);
    expect(CHANGELOG).toContain(
      `[Unreleased]: https://github.com/solwyn-ai/solwyn-typescript-sdk/compare/v${PACKAGE_JSON.version}...HEAD`,
    );
    expect(CHANGELOG).toContain(
      `[${PACKAGE_JSON.version}]: https://github.com/solwyn-ai/solwyn-typescript-sdk/releases/tag/v${PACKAGE_JSON.version}`,
    );
  });

  it("exports the modality wire contract from the public entry", () => {
    expect(MODALITIES).toEqual(["text", "image", "audio", "video", "embedding"]);
    expectTypeOf<Modality>().toEqualTypeOf<(typeof MODALITIES)[number]>();
    expectTypeOf<MediaUsage>().toMatchTypeOf<{ is_estimated?: boolean }>();
  });

  it("exports the coverage function and structural error classes by runtime identity", () => {
    expect(publicApi.coverage).toBe(directCoverage);
    expect(publicApi.SurfaceInspectionError).toBe(DirectSurfaceInspectionError);
    expect(publicApi.CoverageMismatchError).toBe(DirectCoverageMismatchError);
    expect(publicApi.UntrackedSpendSurfaceError).toBe(DirectUntrackedSpendSurfaceError);
  });

  it("exports coverage models as types without exposing private construction or registration", () => {
    expectTypeOf<CoverageRuntime>().toEqualTypeOf<DirectCoverageRuntime>();
    expectTypeOf<CoverageEntry>().toEqualTypeOf<DirectCoverageEntry>();
    expectTypeOf<CoverageAuditEntry>().toEqualTypeOf<DirectCoverageAuditEntry>();
    expectTypeOf<CoverageExpectation>().toEqualTypeOf<DirectCoverageExpectation>();
    expectTypeOf<CoverageFingerprint>().toEqualTypeOf<DirectCoverageFingerprint>();
    expectTypeOf<CoverageReport>().toEqualTypeOf<DirectCoverageReport>();

    expect(Object.hasOwn(publicApi, "CoverageReport")).toBe(false);
    expect(Object.hasOwn(publicApi, "registerCoverageSource")).toBe(false);
    expect(Object.hasOwn(publicApi, "validateAcknowledgmentForContext")).toBe(false);
    expect(Object.hasOwn(publicApi, "SURFACE_RULES")).toBe(false);
    expect(Object.hasOwn(publicApi, "UntrackedSurfaceReporter")).toBe(false);
  });
});
