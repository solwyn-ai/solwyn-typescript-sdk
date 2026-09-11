import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_DIRECTORY,
  baselineDocumentSchema,
  CAPTURE_FAMILIES,
  type CaptureFamilyDefinition,
  contextFor,
  importCaptureFamily,
  resolveInstalledPackageMetadata,
} from "../../scripts/capture-surface-inventory";
import { auditPublicSurface } from "../helpers/surface-audit";

function selectedFamilies(family: string | undefined): readonly CaptureFamilyDefinition[] {
  if (family === undefined) return CAPTURE_FAMILIES;
  const selected = CAPTURE_FAMILIES.find((candidate) => candidate.name === family);
  if (selected === undefined) throw new Error(`unsupported canary family: ${family}`);
  return [selected];
}

describe("real provider SDK surface canary", () => {
  it.each([
    "",
    "not-a-provider",
  ])("rejects unknown selected family %j with the stable error", (family) => {
    expect(() => selectedFamilies(family)).toThrow(`unsupported canary family: ${family}`);
  });

  it("cannot be disabled with test-control markers", async () => {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    const forbiddenMarkers = [`.${"s"}${"kip"}`, `.${"t"}${"odo"}`];
    expect(forbiddenMarkers.filter((marker) => source.includes(marker))).toEqual([]);
  });

  it("audits every selected real SDK shape against curated rules and its monotone baseline", async () => {
    const families = selectedFamilies(process.env["SOLWYN_SURFACE_CANARY_FAMILY"]);
    for (const family of families) {
      const module = await importCaptureFamily(family);
      const packageName = family.packageNames[0];
      if (packageName === undefined)
        throw new Error(`canary family has no package: ${family.name}`);
      const { version } = await resolveInstalledPackageMetadata(packageName);
      for (const shape of family.build(module)) {
        const baseline = baselineDocumentSchema.parse(
          JSON.parse(await readFile(join(BASELINE_DIRECTORY, `${shape.shapeKey}.json`), "utf8")),
        );
        auditPublicSurface(shape.client, {
          context: contextFor(shape.shapeKey),
          clientFamily: family.name,
          installedVersion: version,
          baselineRows: baseline.rows,
          commandClasses: shape.commandClasses,
        });
      }
    }
  }, 60_000);
});
