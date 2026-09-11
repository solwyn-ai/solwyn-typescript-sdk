import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { get as httpGet, request as httpRequest } from "node:http";
import { get as httpsGet, request as httpsRequest } from "node:https";
import net, { createConnection, connect as netConnect, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls, { connect as tlsConnect } from "node:tls";
import OpenAI from "openai";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  baselineRowsForReport,
  CAPTURE_FAMILIES,
  compareFingerprints,
  contextFor,
  type FingerprintRow,
  findInstalledPackageMetadata,
  fingerprintReport,
  mergeFingerprintManifest,
  parseCaptureArgs,
  recordSocketAttemptDelta,
  renderCaptureFailure,
  renderFingerprintDrift,
  reportFilename,
  resolveInstalledPackageMetadata,
  reviewedCoverageFindings,
  type SurfaceInventoryReport,
  serializeBaselineDocument,
  unionBaselineRows,
  updateBaselineFile,
} from "../../scripts/capture-surface-inventory";
import { type CoverageFingerprint, coverage, Solwyn } from "../../src/index";
import { installOfflineGuard, OfflineViolationError } from "../helpers/offline-guard";

function expectOfflineViolation(operation: () => unknown): void {
  try {
    const result = operation();
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
  } catch (error) {
    expect(error).toBeInstanceOf(OfflineViolationError);
    return;
  }
  throw new Error("expected the offline guard to deny the operation synchronously");
}

function caughtError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}

describe("offline provider capture guard", () => {
  test("denies fetch and increments the process counter once", () => {
    const guard = installOfflineGuard();
    const attemptsAtStart = guard.socketAttempts();

    expectOfflineViolation(() => globalThis.fetch("file:///offline-provider-capture"));

    expect(guard.socketAttempts() - attemptsAtStart).toBe(1);
  });

  test("denies named HTTP, HTTPS, net, socket, and TLS entry points", () => {
    const guard = installOfflineGuard();
    const attemptsAtStart = guard.socketAttempts();
    const deniedOperations: Array<() => unknown> = [
      () => httpRequest("ftp://offline.invalid"),
      () => httpGet("ftp://offline.invalid"),
      () => httpsRequest("http://offline.invalid"),
      () => httpsGet("http://offline.invalid"),
      () => netConnect({ port: -1 }),
      () => createConnection({ port: -1 }),
      () => Reflect.apply(Socket.prototype.connect, new Socket(), [{ port: -1 }]),
      () => tlsConnect({ port: -1 }),
    ];

    for (const operation of deniedOperations) {
      expectOfflineViolation(operation);
    }

    expect(guard.socketAttempts() - attemptsAtStart).toBe(deniedOperations.length);
  });

  test("denies runtime-present connectAsync variants", () => {
    const guard = installOfflineGuard();
    const attemptsAtStart = guard.socketAttempts();
    const candidates = [
      [net, "connectAsync"],
      [Socket.prototype, "connectAsync"],
      [tls, "connectAsync"],
      [tls.TLSSocket.prototype, "connectAsync"],
    ] as const;
    const operations: Array<() => unknown> = [];

    for (const [candidate, key] of candidates) {
      const method = Reflect.get(candidate, key) as unknown;
      if (typeof method === "function") {
        operations.push(() =>
          Reflect.apply(method as (...args: unknown[]) => unknown, candidate, [{ port: -1 }]),
        );
      }
    }

    for (const operation of operations) {
      expectOfflineViolation(operation);
    }
    expect(guard.socketAttempts() - attemptsAtStart).toBe(operations.length);
  });

  test("is idempotent and does not stack denial wrappers", () => {
    const first = installOfflineGuard();
    const second = installOfflineGuard();
    const attemptsAtStart = first.socketAttempts();

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expectOfflineViolation(() => httpRequest("ftp://offline.invalid"));
    expect(first.socketAttempts() - attemptsAtStart).toBe(1);
  });
});

function sampleReport(overrides: Partial<SurfaceInventoryReport> = {}): SurfaceInventoryReport {
  return {
    schema_version: 1,
    shape_key: "openai-native",
    client_shape: "openai_sdk",
    provider: "openai",
    variant: "native",
    structural_interval: "latest",
    distributions: [{ name: "openai", version: "6.45.0" }],
    node_version: "22.0.0",
    socket_attempts: 0,
    namespaces: ["responses"],
    observations: [
      ["responses", "getter:resource"],
      ["responses.create", "method:function"],
    ],
    command_classes: [],
    ...overrides,
  };
}

function fingerprint(shapeKey: string, interval: string, hashCharacter = "a"): FingerprintRow {
  return {
    shape_key: shapeKey,
    client_shape: shapeKey === "anthropic-native" ? "anthropic_sdk" : "openai_sdk",
    provider: shapeKey === "anthropic-native" ? "anthropic" : "openai",
    variant: "native",
    structural_interval: interval,
    distributions: [{ name: "fixture", version: "1.0.0" }],
    namespace_count: 1,
    observation_count: 2,
    command_class_count: 0,
    structure_sha256: hashCharacter.repeat(64),
  };
}

describe("provider surface capture pure contracts", () => {
  test("records only the current capture's socket-attempt delta", () => {
    const guard = installOfflineGuard();
    const attemptsAtStart = guard.socketAttempts();

    expectOfflineViolation(() => globalThis.fetch("file:///capture-delta"));

    expect(
      recordSocketAttemptDelta([sampleReport()], guard, attemptsAtStart)[0]?.socket_attempts,
    ).toBe(1);
  });

  test("fingerprints structural data independently of run provenance", () => {
    const first = fingerprintReport(sampleReport());
    const second = fingerprintReport(
      sampleReport({
        distributions: [{ name: "openai", version: "99.0.0" }],
        node_version: "99.0.0",
        socket_attempts: 17,
      }),
    );

    expect(first.structure_sha256).toBe(second.structure_sha256);
    expect(first.distributions).not.toEqual(second.distributions);
  });

  test("fingerprints change when the observed graph changes", () => {
    const first = fingerprintReport(sampleReport());
    const second = fingerprintReport(
      sampleReport({
        observations: [
          ["responses", "getter:resource"],
          ["responses.create", "field:scalar"],
        ],
      }),
    );

    expect(first.structure_sha256).not.toBe(second.structure_sha256);
  });

  test("renders fingerprint count deltas in the fixed actionable order", () => {
    const expected = fingerprint("openai-native", "latest");
    const actual: FingerprintRow = {
      ...expected,
      namespace_count: 2,
      observation_count: 3,
      command_class_count: 1,
      structure_sha256: "b".repeat(64),
    };

    expect(renderFingerprintDrift(expected, actual)).toBe(
      "fingerprint drift: openai-native@latest (namespace_count 1 -> 2, delta +1; observation_count 2 -> 3, delta +1; command_class_count 0 -> 1, delta +1)",
    );
  });

  test("renders zero count deltas when only the structural hash moves", () => {
    const expected = fingerprint("openai-native", "latest");
    const actual = { ...expected, structure_sha256: "b".repeat(64) };

    expect(renderFingerprintDrift(expected, actual)).toBe(
      "fingerprint drift: openai-native@latest (namespace_count 1 -> 1, delta +0; observation_count 2 -> 2, delta +0; command_class_count 0 -> 0, delta +0)",
    );
  });

  test("replaces selected fingerprint cells while preserving unrelated rows", () => {
    const unrelated = fingerprint("anthropic-native", "floor");
    const prior = fingerprint("openai-native", "latest");
    const replacement = {
      ...prior,
      distributions: [{ name: "openai", version: "6.46.0" }],
      structure_sha256: "c".repeat(64),
    };

    const merged = mergeFingerprintManifest(
      { schema_version: 1, fingerprints: [prior, unrelated] },
      [replacement],
    );

    expect(merged.fingerprints).toEqual([unrelated, replacement]);
  });

  test("reports missing reports, missing fingerprints, and structural drift exactly", () => {
    const actual = sampleReport();
    const actualFingerprint = fingerprintReport(actual);
    const driftedExpected = {
      ...actualFingerprint,
      structure_sha256: "d".repeat(64),
    };

    expect(
      compareFingerprints({
        manifest: { schema_version: 1, fingerprints: [driftedExpected] },
        reports: [actual],
        selectedCells: [
          ["anthropic-native", "latest"],
          ["openai-native", "latest"],
        ],
      }),
    ).toEqual([
      "missing report: anthropic-native@latest",
      "fingerprint drift: openai-native@latest (namespace_count 1 -> 1, delta +0; observation_count 2 -> 2, delta +0; command_class_count 0 -> 0, delta +0)",
    ]);

    expect(
      compareFingerprints({
        manifest: { schema_version: 1, fingerprints: [] },
        reports: [actual],
        selectedCells: [["openai-native", "latest"]],
      }),
    ).toEqual(["missing fingerprint: openai-native@latest"]);
  });

  test("renders duplicate CLI contract failures exactly and redacts unknown SDK failures", () => {
    const actual = sampleReport();
    const actualFingerprint = fingerprintReport(actual);
    const duplicateFingerprint = caughtError(() =>
      mergeFingerprintManifest(
        { schema_version: 1, fingerprints: [actualFingerprint, actualFingerprint] },
        [],
      ),
    );
    const duplicateReport = caughtError(() =>
      compareFingerprints({
        manifest: { schema_version: 1, fingerprints: [] },
        reports: [actual, actual],
      }),
    );

    expect(renderCaptureFailure(duplicateFingerprint)).toBe(
      "duplicate fingerprint: openai-native@latest",
    );
    expect(renderCaptureFailure(duplicateReport)).toBe("duplicate report: openai-native@latest");
    expect(renderCaptureFailure(new Error("sdk failure containing arbitrary external text"))).toBe(
      "provider surface capture failed",
    );
  });

  test("unions baseline paths and shapes without deleting prior evidence", () => {
    const existing = [
      ["legacy", ["field:scalar"]],
      ["responses", ["getter:unevaluated_accessor"]],
    ] as const;
    const additions = baselineRowsForReport(sampleReport({ command_classes: ["ConverseCommand"] }));

    expect(unionBaselineRows(existing, additions)).toEqual([
      ["ConverseCommand", ["command_class:command_class"]],
      ["legacy", ["field:scalar"]],
      ["responses", ["getter:resource", "getter:unevaluated_accessor"]],
      ["responses.create", ["method:function"]],
    ]);
  });

  test("serializes one baseline row per line deterministically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "solwyn-surface-baseline-"));
    const path = join(directory, "openai-native.json");
    const additions = baselineRowsForReport(sampleReport());

    await updateBaselineFile(path, "openai-native", additions);
    const first = await readFile(path, "utf8");
    await updateBaselineFile(path, "openai-native", additions);
    const second = await readFile(path, "utf8");

    expect(second).toBe(first);
    expect(second).toBe(
      `${serializeBaselineDocument({ schema_version: 1, shape_key: "openai-native", rows: additions })}`,
    );
    expect(second.endsWith("\n")).toBe(true);
    expect(second.split("\n").filter((line) => line.trimStart().startsWith("[")).length).toBe(
      additions.length,
    );
  });

  test("keeps rejecting curated shapes authoritative over the baseline", () => {
    const wrongCuratedShape = sampleReport({
      observations: [["responses.create", "field:scalar"]],
    });
    const baseline = [["responses.create", ["field:scalar"]]] as const;

    expect(reviewedCoverageFindings(wrongCuratedShape, baseline)).toEqual([
      "no reviewed rule or baseline row for 'responses.create' in openai-native",
    ]);
    expect(
      reviewedCoverageFindings(sampleReport({ command_classes: ["UnreviewedCommand"] }), [
        ["UnreviewedCommand", ["command_class:command_class"]],
      ]),
    ).toEqual([]);
  });

  test("declares the exact family, shape, and context vocabulary", () => {
    expect(CAPTURE_FAMILIES.map((family) => family.name)).toEqual([
      "anthropic",
      "bedrock",
      "google-genai",
      "google-generativeai",
      "openai",
      "together",
    ]);
    expect(CAPTURE_FAMILIES.find((family) => family.name === "openai")?.shapeKeys).toEqual([
      "openai-azure",
      "openai-native",
    ]);
    expect(contextFor("google-generativeai")).toEqual({
      provider: "google",
      dialect: "google",
      clientShape: "google_generativeai",
    });
  });

  test("parses exactly one capture mode and a path-safe interval", () => {
    expect(
      parseCaptureArgs([
        "--interval",
        "latest",
        "--family",
        "openai",
        "--check",
        "--output-dir",
        "tmp/reports",
      ]),
    ).toEqual({
      interval: "latest",
      family: "openai",
      mode: "check",
      outputDir: "tmp/reports",
    });
    expect(() => parseCaptureArgs(["--interval", "LATEST", "--check"])).toThrow(
      "structural_interval must be a lowercase path-safe label",
    );
    expect(() => parseCaptureArgs(["--interval", "latest", "--check", "--update"])).toThrow(
      "exactly one of --check or --update is required",
    );
  });

  test("uses the deterministic shape-at-interval report filename", () => {
    expect(reportFilename(sampleReport())).toBe("openai-native@latest.json");
  });

  test("finds matching package metadata by walking upward from the resolved entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "solwyn-package-version-"));
    const packageRoot = join(directory, "node_modules", "fixture-sdk");
    const entryDirectory = join(packageRoot, "dist", "esm");
    await mkdir(entryDirectory, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-sdk", version: "1.2.3" }),
    );
    const entryPath = join(entryDirectory, "index.js");
    await writeFile(entryPath, "export {};\n");

    await expect(findInstalledPackageMetadata(entryPath, "fixture-sdk")).resolves.toEqual({
      name: "fixture-sdk",
      version: "1.2.3",
    });
    await expect(findInstalledPackageMetadata(entryPath, "different-sdk")).rejects.toThrow(
      "could not locate package metadata for different-sdk",
    );
  });
});

const fixtureDistributionSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
});

const fixtureFingerprintSchema = z.strictObject({
  shape_key: z.string().min(1),
  client_shape: z.string().min(1),
  provider: z.string().min(1),
  variant: z.enum(["native", "azure"]),
  structural_interval: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  distributions: z.array(fixtureDistributionSchema),
  namespace_count: z.number().int().nonnegative(),
  observation_count: z.number().int().nonnegative(),
  command_class_count: z.number().int().nonnegative(),
  structure_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const fixtureManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  fingerprints: z.array(fixtureFingerprintSchema),
});

const coverageFingerprintSchema = z.strictObject({
  conditional: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  guarded_namespaces: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  tracked: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  unknown: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  blocked: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  unsupported: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  safe: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scoped_escapes: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  untracked: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const intervalCatalogSchema = z.strictObject({
  schema_version: z.literal(1),
  include: z.array(
    z.strictObject({
      family: z.string().min(1),
      interval: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
      packages: z.array(z.string().min(1)).min(1),
    }),
  ),
});

const fixtureBaselineSchema = z.strictObject({
  schema_version: z.literal(1),
  shape_key: z.string().min(1),
  rows: z.array(
    z.tuple([
      z.string().min(1),
      z.array(z.string().regex(/^(getter|setter_only|method|field|command_class):[a-z_]+$/)).min(1),
    ]),
  ),
});

const EXPECTED_CATALOG_ROWS = [
  ["anthropic", "floor", ["@anthropic-ai/sdk@0.30.0"]],
  ["anthropic", "latest", ["@anthropic-ai/sdk@0.123.0"]],
  ["bedrock", "floor", ["@aws-sdk/client-bedrock-runtime@3.422.0"]],
  ["bedrock", "latest", ["@aws-sdk/client-bedrock-runtime@3.1124.0"]],
  ["google-genai", "floor", ["@google/genai@0.3.1"]],
  ["google-genai", "latest", ["@google/genai@2.20.0"]],
  ["google-generativeai", "latest", ["@google/generative-ai@0.24.1"]],
  ["openai", "floor", ["openai@4.41.0"]],
  ["openai", "latest", ["openai@6.45.0"]],
  ["together", "floor", ["together-ai@0.16.0"]],
  ["together", "latest", ["together-ai@0.50.0"]],
] as const;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function documentedOpenAIStrictFingerprint(readme: string): CoverageFingerprint {
  const fences = [...readme.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .filter((fence) => fence.includes("OPENAI_STRICT_FINGERPRINT"));
  if (fences.length !== 1) {
    throw new Error("README requires one TypeScript OPENAI_STRICT_FINGERPRINT example");
  }
  const fence = fences[0] ?? "";
  if (/\.fingerprint\b/.test(fence)) {
    throw new Error("README strict coverage example must use an independently reviewed literal");
  }
  const directExpectCalls = fence.match(
    /^coverage\(client\)\.expect\(OPENAI_STRICT_FINGERPRINT\);$/gm,
  );
  if (directExpectCalls?.length !== 1) {
    throw new Error(
      "README strict coverage example must call coverage(client).expect(OPENAI_STRICT_FINGERPRINT)",
    );
  }
  const literal =
    /const OPENAI_STRICT_FINGERPRINT:\s*CoverageFingerprint\s*=\s*\{([\s\S]*?)\n\};/.exec(fence);
  if (literal === null || fence.indexOf(literal[0]) > fence.indexOf(directExpectCalls[0])) {
    throw new Error("README strict coverage literal must be assigned before it is asserted");
  }
  const fieldRows = [
    ...(literal[1] ?? "").matchAll(/^\s*([a-z_]+):\s*"(sha256:[a-f0-9]{64})",?$/gm),
  ].map((match) => [match[1], match[2]] as const);
  if (fieldRows.length !== new Set(fieldRows.map(([name]) => name)).size) {
    throw new Error("README strict coverage literal must not repeat categories");
  }
  const fields = Object.fromEntries(fieldRows);
  return coverageFingerprintSchema.parse(fields) as CoverageFingerprint;
}

function latestOpenAIVersion(manifest: z.infer<typeof fixtureManifestSchema>): string {
  const rows = manifest.fingerprints.filter(
    (row) =>
      row.provider === "openai" && row.variant === "native" && row.structural_interval === "latest",
  );
  if (rows.length !== 1) throw new Error("latest native OpenAI fingerprint must be unique");
  const distributions = rows[0]?.distributions.filter(({ name }) => name === "openai") ?? [];
  if (distributions.length !== 1) {
    throw new Error("latest native OpenAI fingerprint requires one OpenAI distribution");
  }
  return distributions[0]?.version ?? "";
}

describe("committed provider surface interval evidence", () => {
  test("declares only the reviewed optional peer compatibility intervals", async () => {
    const packageJson = (await readJson("package.json")) as {
      readonly devDependencies: Readonly<Record<string, string>>;
      readonly engines: Readonly<Record<string, string>>;
      readonly peerDependencies: Readonly<Record<string, string>>;
    };

    expect(packageJson.engines).toEqual({ node: ">=20" });
    expect(packageJson.peerDependencies).toEqual({
      "@anthropic-ai/sdk": ">=0.30.0 <1",
      "@aws-sdk/client-bedrock-runtime": ">=3.422.0 <4",
      "@google/genai": ">=0.3.1 <3",
      ai: ">=7.0.14 <8",
      openai: ">=4.41.0 <7",
      "together-ai": ">=0.16.0 <1",
    });
    expect(packageJson.devDependencies["ai"]).toBe("7.0.14");
  });

  test("catalog pins the exact approved floor and latest package rows", async () => {
    const catalog = intervalCatalogSchema.parse(
      await readJson("tests/provider-surface-intervals.json"),
    );
    const rows = catalog.include
      .map((row) => [row.family, row.interval, row.packages] as const)
      .sort((left, right) => `${left[0]}@${left[1]}`.localeCompare(`${right[0]}@${right[1]}`));

    expect(rows).toEqual(EXPECTED_CATALOG_ROWS);
    expect(new Set(rows.map(([family, interval]) => `${family}@${interval}`)).size).toBe(11);
    for (const family of CAPTURE_FAMILIES) {
      const intervals = rows
        .filter(([candidate]) => candidate === family.name)
        .map(([, interval]) => interval);
      expect(intervals).toContain("latest");
      if (family.name === "google-generativeai") {
        expect(intervals).toEqual(["latest"]);
      } else {
        expect(intervals).toEqual(["floor", "latest"]);
      }
    }
  });

  test("manifest covers every catalog shape cell exactly once", async () => {
    const catalog = intervalCatalogSchema.parse(
      await readJson("tests/provider-surface-intervals.json"),
    );
    const manifest = fixtureManifestSchema.parse(
      await readJson("tests/provider-surface-fingerprints.json"),
    );
    const expectedCells = catalog.include.flatMap((row) => {
      const family = CAPTURE_FAMILIES.find((candidate) => candidate.name === row.family);
      if (family === undefined) throw new Error(`unknown fixture family: ${row.family}`);
      return family.shapeKeys.map((shapeKey) => `${shapeKey}@${row.interval}`);
    });
    const actualCells = manifest.fingerprints.map(
      (row) => `${row.shape_key}@${row.structural_interval}`,
    );

    expect(expectedCells).toHaveLength(13);
    expect(new Set(actualCells).size).toBe(actualCells.length);
    expect([...actualCells].sort()).toEqual([...expectedCells].sort());
    for (const row of manifest.fingerprints) {
      expect(row.observation_count).toBeGreaterThan(0);
      expect(row.structure_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(manifest.fingerprints).toEqual(
      [...manifest.fingerprints].sort((left, right) =>
        `${left.shape_key}@${left.structural_interval}`.localeCompare(
          `${right.shape_key}@${right.structural_interval}`,
        ),
      ),
    );
  });

  test("catalog and manifest provenance agree for every interval", async () => {
    const catalog = intervalCatalogSchema.parse(
      await readJson("tests/provider-surface-intervals.json"),
    );
    const manifest = fixtureManifestSchema.parse(
      await readJson("tests/provider-surface-fingerprints.json"),
    );

    for (const catalogRow of catalog.include) {
      const family = CAPTURE_FAMILIES.find((candidate) => candidate.name === catalogRow.family);
      if (family === undefined) throw new Error(`unknown fixture family: ${catalogRow.family}`);
      expect(catalogRow.packages).toHaveLength(1);
      const packageSpec = catalogRow.packages[0];
      if (packageSpec === undefined) throw new Error(`missing package spec: ${catalogRow.family}`);
      const versionSeparator = packageSpec.lastIndexOf("@");
      if (versionSeparator < 1 || versionSeparator === packageSpec.length - 1) {
        throw new Error(`invalid package spec: ${packageSpec}`);
      }
      const distribution = {
        name: packageSpec.slice(0, versionSeparator),
        version: packageSpec.slice(versionSeparator + 1),
      };

      for (const shapeKey of family.shapeKeys) {
        expect(
          manifest.fingerprints.find(
            (row) => row.shape_key === shapeKey && row.structural_interval === catalogRow.interval,
          )?.distributions,
        ).toEqual([distribution]);
      }
    }
  });

  test("latest provenance agrees across package pins, catalog, manifest, and install", async () => {
    const packageJson = (await readJson("package.json")) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const catalog = intervalCatalogSchema.parse(
      await readJson("tests/provider-surface-intervals.json"),
    );
    const manifest = fixtureManifestSchema.parse(
      await readJson("tests/provider-surface-fingerprints.json"),
    );

    for (const family of CAPTURE_FAMILIES) {
      expect(family.packageNames).toHaveLength(1);
      const packageName = family.packageNames[0];
      if (packageName === undefined) throw new Error(`missing package name: ${family.name}`);
      const version = packageJson.devDependencies[packageName];
      if (version === undefined) throw new Error(`missing exact dev pin: ${packageName}`);
      expect(
        catalog.include.find((row) => row.family === family.name && row.interval === "latest")
          ?.packages,
      ).toEqual([`${packageName}@${version}`]);
      await expect(resolveInstalledPackageMetadata(packageName)).resolves.toEqual({
        name: packageName,
        version,
      });
      for (const shapeKey of family.shapeKeys) {
        expect(
          manifest.fingerprints.find(
            (row) => row.shape_key === shapeKey && row.structural_interval === "latest",
          )?.distributions,
        ).toEqual([{ name: packageName, version }]);
      }
    }
  });

  test("README pins the reviewed strict OpenAI coverage contract without provider I/O", async () => {
    const guard = installOfflineGuard();
    const attemptsAtStart = guard.socketAttempts();
    const readme = await readFile("README.md", "utf8");
    const manifest = fixtureManifestSchema.parse(
      await readJson("tests/provider-surface-fingerprints.json"),
    );
    const expected = documentedOpenAIStrictFingerprint(readme);
    const client = new Solwyn(new OpenAI({ apiKey: "sk-offline" }), {
      apiKey: `sk_proj_${"a".repeat(64)}`,
      acknowledgeUntracked: [],
      onUnmetered: "raise",
      reportUntrackedSurfaces: false,
    });

    try {
      expect(readme).toContain(`openai@${latestOpenAIVersion(manifest)}`);
      expect(() => coverage(client).expect(expected)).not.toThrow();
    } finally {
      await client.close();
    }
    expect(guard.socketAttempts() - attemptsAtStart).toBe(0);
  });

  test("pack-smoke metadata sources cover every capture-family provider package", async () => {
    const packageJson = (await readJson("package.json")) as {
      readonly peerDependenciesMeta: Readonly<
        Record<string, { readonly optional?: boolean } | undefined>
      >;
    };
    const catalog = intervalCatalogSchema.parse(
      await readJson("tests/provider-surface-intervals.json"),
    );
    const catalogPackages = catalog.include.flatMap((row) => row.packages);
    for (const packageName of CAPTURE_FAMILIES.flatMap((family) => family.packageNames)) {
      expect(
        packageJson.peerDependenciesMeta[packageName]?.optional === true ||
          catalogPackages.some((packageSpec) => packageSpec.startsWith(`${packageName}@`)),
      ).toBe(true);
    }
  });

  test("all seven baseline fixtures are strict, sorted, and canonically serialized", async () => {
    const shapeKeys = CAPTURE_FAMILIES.flatMap((family) => family.shapeKeys).sort();
    expect(shapeKeys).toHaveLength(7);

    for (const shapeKey of shapeKeys) {
      const path = `tests/surface-baseline/${shapeKey}.json`;
      const text = await readFile(path, "utf8");
      const baseline = fixtureBaselineSchema.parse(JSON.parse(text));
      expect(baseline.shape_key).toBe(shapeKey);
      expect(baseline.rows.map(([surface]) => surface)).toEqual(
        baseline.rows.map(([surface]) => surface).sort(),
      );
      for (const [, shapes] of baseline.rows) {
        expect(shapes).toEqual([...new Set(shapes)].sort());
      }
      expect(text).toBe(serializeBaselineDocument(baseline));
    }
  });

  test("every committed floor/latest baseline shape agrees with curated rules for its context", async () => {
    const shapeKeys = CAPTURE_FAMILIES.flatMap((family) => family.shapeKeys).sort();

    for (const shapeKey of shapeKeys) {
      const baseline = fixtureBaselineSchema.parse(
        await readJson(`tests/surface-baseline/${shapeKey}.json`),
      );
      const observations = baseline.rows.flatMap(([path, shapes]) =>
        shapes.map((shape) => [path, shape] as const),
      );
      const context = contextFor(shapeKey);
      const report = sampleReport({
        shape_key: shapeKey,
        client_shape: context.clientShape,
        provider: context.provider ?? shapeKey,
        variant: shapeKey === "openai-azure" ? "azure" : "native",
        structural_interval: "baseline-union",
        distributions: [],
        namespaces: [],
        observations,
        command_classes: [],
      });

      expect(reviewedCoverageFindings(report, baseline.rows)).toEqual([]);
    }
  });

  test("fresh CLI latest capture matches fingerprints and reviewed baseline", () => {
    expect(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/capture-surface-inventory.ts",
          "--interval",
          "latest",
          "--check",
        ],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toBe("");
  });
});
