import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DESCRIPTOR_CATEGORIES,
  type DescriptorCategory,
  RETURN_SHAPES,
  type ReturnShape,
  resolveSurfaceRule,
  SURFACE_CLIENT_SHAPES,
  type SurfaceClientShape,
  type SurfaceContext,
} from "../src/surfaces";
import { installOfflineGuard, type OfflineGuardHandle } from "../tests/helpers/offline-guard";
import { type BaselineRow, observeReviewedPublicSurface } from "../tests/helpers/surface-audit";

const SCHEMA_VERSION = 1 as const;
const INTERVAL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const BASELINE_SHAPE_PATTERN = /^(getter|setter_only|method|field|command_class):[a-z_]+$/;

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUTPUT_DIRECTORY = join(
  REPOSITORY_ROOT,
  "build",
  "provider-surface-inventory",
);
export const FINGERPRINT_MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  "tests",
  "provider-surface-fingerprints.json",
);
export const BASELINE_DIRECTORY = join(REPOSITORY_ROOT, "tests", "surface-baseline");

export interface DistributionRow {
  readonly name: string;
  readonly version: string;
}

export interface SurfaceInventoryReport {
  readonly schema_version: 1;
  readonly shape_key: string;
  readonly client_shape: SurfaceClientShape;
  readonly provider: string;
  readonly variant: "native" | "azure";
  readonly structural_interval: string;
  readonly distributions: readonly DistributionRow[];
  readonly node_version: string;
  readonly socket_attempts: number;
  readonly namespaces: readonly string[];
  readonly observations: readonly (readonly [path: string, shape: string])[];
  readonly command_classes: readonly string[];
}

export interface FingerprintRow {
  readonly shape_key: string;
  readonly client_shape: string;
  readonly provider: string;
  readonly variant: "native" | "azure";
  readonly structural_interval: string;
  readonly distributions: readonly DistributionRow[];
  readonly namespace_count: number;
  readonly observation_count: number;
  readonly command_class_count: number;
  readonly structure_sha256: string;
}

export interface FingerprintManifest {
  readonly schema_version: 1;
  readonly fingerprints: readonly FingerprintRow[];
}

export interface BaselineDocument {
  readonly schema_version: 1;
  readonly shape_key: string;
  readonly rows: readonly BaselineRow[];
}

export type FingerprintCell = readonly [shapeKey: string, interval: string];

const distributionSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
});

export const fingerprintRowSchema = z.strictObject({
  shape_key: z.string().min(1),
  client_shape: z.string().min(1),
  provider: z.string().min(1),
  variant: z.enum(["native", "azure"]),
  structural_interval: z.string().regex(INTERVAL_PATTERN),
  distributions: z.array(distributionSchema),
  namespace_count: z.number().int().nonnegative(),
  observation_count: z.number().int().nonnegative(),
  command_class_count: z.number().int().nonnegative(),
  structure_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const fingerprintManifestSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  fingerprints: z.array(fingerprintRowSchema),
});

const baselineRowSchema = z.tuple([
  z.string().min(1),
  z.array(z.string().regex(BASELINE_SHAPE_PATTERN)).min(1),
]);

export const baselineDocumentSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  shape_key: z.string().min(1),
  rows: z.array(baselineRowSchema),
});

const reportSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  shape_key: z.string().min(1),
  client_shape: z.enum(SURFACE_CLIENT_SHAPES),
  provider: z.string().min(1),
  variant: z.enum(["native", "azure"]),
  structural_interval: z.string().regex(INTERVAL_PATTERN),
  distributions: z.array(distributionSchema),
  node_version: z.string().min(1),
  socket_attempts: z.number().int().nonnegative(),
  namespaces: z.array(z.string()),
  observations: z.array(z.tuple([z.string(), z.string().regex(BASELINE_SHAPE_PATTERN)])),
  command_classes: z.array(z.string()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalValue(value[key]);
    }
    return result;
  }
  return value;
}

/** JSON with recursively sorted object keys and preserved array order. */
export function canonicalJson(value: unknown): string {
  const rendered = JSON.stringify(canonicalValue(value));
  if (rendered === undefined) {
    throw new TypeError("canonical JSON input must be serializable");
  }
  return rendered;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCells(left: FingerprintCell, right: FingerprintCell): number {
  return compareText(left[0], right[0]) || compareText(left[1], right[1]);
}

function fingerprintCell(
  row: Pick<FingerprintRow, "shape_key" | "structural_interval">,
): FingerprintCell {
  return [row.shape_key, row.structural_interval];
}

function displayCell(cell: FingerprintCell): string {
  return `${cell[0]}@${cell[1]}`;
}

class CaptureContractError extends Error {
  constructor(kind: "duplicate fingerprint" | "duplicate report", cell: FingerprintCell) {
    super(`${kind}: ${displayCell(cell)}`);
    this.name = "CaptureContractError";
  }
}

export function renderCaptureFailure(error: unknown): string {
  return error instanceof CaptureContractError ? error.message : "provider surface capture failed";
}

function cellIdentity(cell: FingerprintCell): string {
  return JSON.stringify(cell);
}

function normalizeDistributions(rows: readonly DistributionRow[]): readonly DistributionRow[] {
  return [...rows]
    .map((row) => ({ name: row.name, version: row.version }))
    .sort((left, right) => compareText(left.name, right.name));
}

function normalizeReport(report: SurfaceInventoryReport): SurfaceInventoryReport {
  return reportSchema.parse({
    ...report,
    distributions: normalizeDistributions(report.distributions),
    namespaces: [...new Set(report.namespaces)].sort(compareText),
    observations: [...report.observations]
      .map(([path, shape]) => [path, shape] as const)
      .sort(
        ([leftPath, leftShape], [rightPath, rightShape]) =>
          compareText(leftPath, rightPath) || compareText(leftShape, rightShape),
      ),
    command_classes: [...new Set(report.command_classes)].sort(compareText),
  }) as SurfaceInventoryReport;
}

function structuralPayload(normalized: SurfaceInventoryReport): unknown {
  return {
    schema_version: normalized.schema_version,
    shape_key: normalized.shape_key,
    client_shape: normalized.client_shape,
    provider: normalized.provider,
    variant: normalized.variant,
    structural_interval: normalized.structural_interval,
    namespaces: normalized.namespaces,
    observations: normalized.observations,
    command_classes: normalized.command_classes,
  };
}

/** Produce a provenance-bearing row with a provenance-independent structural hash. */
export function fingerprintReport(report: SurfaceInventoryReport): FingerprintRow {
  const normalized = normalizeReport(report);
  return {
    shape_key: normalized.shape_key,
    client_shape: normalized.client_shape,
    provider: normalized.provider,
    variant: normalized.variant,
    structural_interval: normalized.structural_interval,
    distributions: normalized.distributions,
    namespace_count: normalized.namespaces.length,
    observation_count: normalized.observations.length,
    command_class_count: normalized.command_classes.length,
    structure_sha256: createHash("sha256")
      .update(canonicalJson(structuralPayload(normalized)))
      .digest("hex"),
  };
}

export function renderFingerprintDrift(expected: FingerprintRow, actual: FingerprintRow): string {
  const counts = ["namespace_count", "observation_count", "command_class_count"] as const;
  const rendered = counts
    .map((name) => {
      const delta = actual[name] - expected[name];
      return `${name} ${expected[name]} -> ${actual[name]}, delta ${delta >= 0 ? "+" : ""}${delta}`;
    })
    .join("; ");
  return `fingerprint drift: ${displayCell(fingerprintCell(actual))} (${rendered})`;
}

function indexFingerprintRows(rows: readonly FingerprintRow[]): Map<string, FingerprintRow> {
  const indexed = new Map<string, FingerprintRow>();
  for (const row of rows) {
    const parsed = fingerprintRowSchema.parse(row) as FingerprintRow;
    const cell = fingerprintCell(parsed);
    const identity = cellIdentity(cell);
    if (indexed.has(identity)) {
      throw new CaptureContractError("duplicate fingerprint", cell);
    }
    indexed.set(identity, parsed);
  }
  return indexed;
}

export function mergeFingerprintManifest(
  manifest: FingerprintManifest,
  replacements: readonly FingerprintRow[],
): FingerprintManifest {
  fingerprintManifestSchema.parse(manifest);
  const indexed = indexFingerprintRows(manifest.fingerprints);
  for (const [identity, replacement] of indexFingerprintRows(replacements)) {
    indexed.set(identity, replacement);
  }
  const fingerprints = [...indexed.values()].sort((left, right) =>
    compareCells(fingerprintCell(left), fingerprintCell(right)),
  );
  return { schema_version: SCHEMA_VERSION, fingerprints };
}

function comparableFingerprint(row: FingerprintRow): unknown {
  return {
    shape_key: row.shape_key,
    client_shape: row.client_shape,
    provider: row.provider,
    variant: row.variant,
    structural_interval: row.structural_interval,
    namespace_count: row.namespace_count,
    observation_count: row.observation_count,
    command_class_count: row.command_class_count,
    structure_sha256: row.structure_sha256,
  };
}

export function compareFingerprints(options: {
  readonly manifest: FingerprintManifest;
  readonly reports: readonly SurfaceInventoryReport[];
  readonly selectedCells?: readonly FingerprintCell[];
}): readonly string[] {
  fingerprintManifestSchema.parse(options.manifest);
  const expected = indexFingerprintRows(options.manifest.fingerprints);
  const actual = new Map<string, SurfaceInventoryReport>();
  for (const report of options.reports) {
    const normalized = normalizeReport(report);
    const cell = [normalized.shape_key, normalized.structural_interval] as const;
    const identity = cellIdentity(cell);
    if (actual.has(identity)) {
      throw new CaptureContractError("duplicate report", cell);
    }
    actual.set(identity, normalized);
  }

  const cells = options.selectedCells ?? options.reports.map(fingerprintCell);
  const selectedIdentities = new Set<string>();
  const findings: string[] = [];
  for (const cell of [...cells].sort(compareCells)) {
    const identity = cellIdentity(cell);
    if (selectedIdentities.has(identity)) {
      throw new Error(`duplicate selected cell: ${displayCell(cell)}`);
    }
    selectedIdentities.add(identity);
    const report = actual.get(identity);
    if (report === undefined) {
      findings.push(`missing report: ${displayCell(cell)}`);
      continue;
    }
    const expectedRow = expected.get(identity);
    if (expectedRow === undefined) {
      findings.push(`missing fingerprint: ${displayCell(cell)}`);
      continue;
    }
    const actualRow = fingerprintReport(report);
    if (
      canonicalJson(comparableFingerprint(expectedRow)) !==
      canonicalJson(comparableFingerprint(actualRow))
    ) {
      findings.push(renderFingerprintDrift(expectedRow, actualRow));
    }
  }
  return findings;
}

export function baselineRowsForReport(report: SurfaceInventoryReport): readonly BaselineRow[] {
  const additions: BaselineRow[] = report.observations.map(([path, shape]) => [path, [shape]]);
  for (const commandClass of report.command_classes) {
    additions.push([commandClass, ["command_class:command_class"]]);
  }
  return unionBaselineRows([], additions);
}

export function unionBaselineRows(
  existing: readonly BaselineRow[],
  additions: readonly BaselineRow[],
): readonly BaselineRow[] {
  const shapesByPath = new Map<string, Set<string>>();
  for (const [path, shapes] of [...existing, ...additions]) {
    let merged = shapesByPath.get(path);
    if (merged === undefined) {
      merged = new Set<string>();
      shapesByPath.set(path, merged);
    }
    for (const shape of shapes) {
      merged.add(shape);
    }
  }
  return [...shapesByPath]
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, shapes]) => [path, [...shapes].sort(compareText)] as const);
}

/** Deterministic baseline JSON with exactly one compact row on each row line. */
export function serializeBaselineDocument(document: BaselineDocument): string {
  const normalized: BaselineDocument = {
    schema_version: SCHEMA_VERSION,
    shape_key: document.shape_key,
    rows: unionBaselineRows([], document.rows),
  };
  baselineDocumentSchema.parse(normalized);
  const rowLines = normalized.rows.map((row) => `    ${JSON.stringify(row)}`);
  return `{
  "schema_version": 1,
  "shape_key": ${JSON.stringify(normalized.shape_key)},
  "rows": [
${rowLines.join(",\n")}
  ]
}
`;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

async function loadBaselineFile(path: string, shapeKey: string): Promise<BaselineDocument> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { schema_version: SCHEMA_VERSION, shape_key: shapeKey, rows: [] };
    }
    throw error;
  }
  const parsed = baselineDocumentSchema.parse(JSON.parse(text)) as BaselineDocument;
  if (parsed.shape_key !== shapeKey) {
    throw new Error(`baseline shape_key mismatch: expected ${shapeKey}, got ${parsed.shape_key}`);
  }
  return parsed;
}

export async function updateBaselineFile(
  path: string,
  shapeKey: string,
  additions: readonly BaselineRow[],
): Promise<void> {
  const existing = await loadBaselineFile(path, shapeKey);
  const merged: BaselineDocument = {
    schema_version: SCHEMA_VERSION,
    shape_key: shapeKey,
    rows: unionBaselineRows(existing.rows, additions),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeBaselineDocument(merged), "utf8");
}

function parseEncodedShape(shape: string): {
  readonly descriptorCategory: DescriptorCategory;
  readonly returnShape: ReturnShape;
} {
  const separator = shape.indexOf(":");
  const descriptorCategory = shape.slice(0, separator);
  const returnShape = shape.slice(separator + 1);
  if (
    separator <= 0 ||
    !DESCRIPTOR_CATEGORIES.includes(descriptorCategory as DescriptorCategory) ||
    !RETURN_SHAPES.includes(returnShape as ReturnShape)
  ) {
    throw new Error(`invalid surface observation shape: ${shape}`);
  }
  return {
    descriptorCategory: descriptorCategory as DescriptorCategory,
    returnShape: returnShape as ReturnShape,
  };
}

function baselineMap(rows: readonly BaselineRow[]): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const [path, shapes] of rows) {
    const merged = result.get(path) ?? new Set<string>();
    for (const shape of shapes) {
      merged.add(shape);
    }
    result.set(path, merged);
  }
  return result;
}

export function reviewedCoverageFindings(
  report: SurfaceInventoryReport,
  baselineRows: readonly BaselineRow[],
): readonly string[] {
  const context = contextFor(report.shape_key);
  const baseline = baselineMap(baselineRows);
  const rows = baselineRowsForReport(report);
  const findings: string[] = [];
  for (const [path, shapes] of rows) {
    const rule = resolveSurfaceRule({ context, path, source: "raw" });
    let allCovered = true;
    for (const shape of shapes) {
      const observationShape = parseEncodedShape(shape);
      const covered =
        rule === undefined
          ? baseline.get(path)?.has(shape) === true
          : rule.acceptsShape({ path, ...observationShape });
      if (!covered) {
        allCovered = false;
      }
    }
    if (!allCovered) {
      findings.push(`no reviewed rule or baseline row for '${path}' in ${report.shape_key}`);
    }
  }
  return findings;
}

export type CaptureFamilyName =
  | "anthropic"
  | "bedrock"
  | "google-genai"
  | "google-generativeai"
  | "openai"
  | "together";

export type CaptureShapeKey =
  | "anthropic-native"
  | "bedrock-v3"
  | "google-genai"
  | "google-generativeai"
  | "openai-azure"
  | "openai-native"
  | "together-native";

interface ShapeMetadata {
  readonly context: SurfaceContext;
  readonly variant: "native" | "azure";
}

const SHAPE_METADATA: Readonly<Record<CaptureShapeKey, ShapeMetadata>> = Object.freeze({
  "anthropic-native": Object.freeze({
    context: Object.freeze({
      provider: "anthropic",
      dialect: "anthropic",
      clientShape: "anthropic_sdk",
    }),
    variant: "native",
  }),
  "bedrock-v3": Object.freeze({
    context: Object.freeze({
      provider: "bedrock",
      dialect: "bedrock",
      clientShape: "bedrock_v3",
    }),
    variant: "native",
  }),
  "google-genai": Object.freeze({
    context: Object.freeze({
      provider: "google",
      dialect: "google",
      clientShape: "google_genai",
    }),
    variant: "native",
  }),
  "google-generativeai": Object.freeze({
    context: Object.freeze({
      provider: "google",
      dialect: "google",
      clientShape: "google_generativeai",
    }),
    variant: "native",
  }),
  "openai-azure": Object.freeze({
    context: Object.freeze({
      provider: "azure_openai",
      dialect: "openai",
      clientShape: "openai_sdk",
    }),
    variant: "azure",
  }),
  "openai-native": Object.freeze({
    context: Object.freeze({
      provider: "openai",
      dialect: "openai",
      clientShape: "openai_sdk",
    }),
    variant: "native",
  }),
  "together-native": Object.freeze({
    context: Object.freeze({
      provider: "together",
      dialect: "openai",
      clientShape: "native_together",
    }),
    variant: "native",
  }),
});

function shapeMetadata(shapeKey: string): ShapeMetadata {
  if (!(shapeKey in SHAPE_METADATA)) {
    throw new Error(`unknown capture shape: ${shapeKey}`);
  }
  return SHAPE_METADATA[shapeKey as CaptureShapeKey];
}

export function contextFor(shapeKey: string): SurfaceContext {
  const context = shapeMetadata(shapeKey).context;
  return { ...context };
}

type ProviderModule = Readonly<Record<string, unknown>>;
type ProviderConstructor = new (...arguments_: never[]) => unknown;

export interface BuiltCaptureShape {
  readonly shapeKey: CaptureShapeKey;
  readonly client: unknown;
  readonly commandClasses: readonly string[];
}

export interface CaptureFamilyDefinition {
  readonly name: CaptureFamilyName;
  readonly moduleName: string;
  readonly packageNames: readonly string[];
  readonly shapeKeys: readonly CaptureShapeKey[];
  build(module: ProviderModule): readonly BuiltCaptureShape[];
}

function providerConstructor(
  module: ProviderModule,
  moduleName: string,
  exportNames: readonly string[],
): ProviderConstructor {
  for (const exportName of exportNames) {
    const candidate = module[exportName];
    if (typeof candidate === "function") {
      return candidate as ProviderConstructor;
    }
  }
  throw new Error(`provider module ${moduleName} does not export ${exportNames.join(" or ")}`);
}

function constructProviderClient(
  module: ProviderModule,
  moduleName: string,
  exportNames: readonly string[],
  argumentsList: readonly unknown[],
): unknown {
  return Reflect.construct(providerConstructor(module, moduleName, exportNames), [
    ...argumentsList,
  ]);
}

/** Stable Bedrock operation-surface scan shared by capture and the later canary. */
export function bedrockCommandClasses(module: ProviderModule): readonly string[] {
  return Object.keys(module)
    .filter((name) => /^[A-Z][A-Za-z0-9]*Command$/.test(name))
    .sort(compareText);
}

function builtShape(shapeKey: CaptureShapeKey, client: unknown): BuiltCaptureShape {
  return { shapeKey, client, commandClasses: [] };
}

function defineCaptureFamily(definition: CaptureFamilyDefinition): CaptureFamilyDefinition {
  Object.freeze(definition.packageNames);
  Object.freeze(definition.shapeKeys);
  return Object.freeze(definition);
}

export const CAPTURE_FAMILIES: readonly CaptureFamilyDefinition[] = Object.freeze([
  defineCaptureFamily({
    name: "anthropic",
    moduleName: "@anthropic-ai/sdk",
    packageNames: ["@anthropic-ai/sdk"],
    shapeKeys: ["anthropic-native"],
    build: (module: ProviderModule) => [
      builtShape(
        "anthropic-native",
        constructProviderClient(
          module,
          "@anthropic-ai/sdk",
          ["default", "Anthropic"],
          [{ apiKey: "offline" }],
        ),
      ),
    ],
  }),
  defineCaptureFamily({
    name: "bedrock",
    moduleName: "@aws-sdk/client-bedrock-runtime",
    packageNames: ["@aws-sdk/client-bedrock-runtime"],
    shapeKeys: ["bedrock-v3"],
    build: (module: ProviderModule) => [
      {
        shapeKey: "bedrock-v3",
        client: constructProviderClient(
          module,
          "@aws-sdk/client-bedrock-runtime",
          ["BedrockRuntimeClient"],
          [
            {
              region: "us-east-1",
              credentials: { accessKeyId: "offline", secretAccessKey: "offline" },
            },
          ],
        ),
        commandClasses: bedrockCommandClasses(module),
      },
    ],
  }),
  defineCaptureFamily({
    name: "google-genai",
    moduleName: "@google/genai",
    packageNames: ["@google/genai"],
    shapeKeys: ["google-genai"],
    build: (module: ProviderModule) => [
      builtShape(
        "google-genai",
        constructProviderClient(module, "@google/genai", ["GoogleGenAI"], [{ apiKey: "offline" }]),
      ),
    ],
  }),
  defineCaptureFamily({
    name: "google-generativeai",
    moduleName: "@google/generative-ai",
    packageNames: ["@google/generative-ai"],
    shapeKeys: ["google-generativeai"],
    build: (module: ProviderModule) => [
      builtShape(
        "google-generativeai",
        constructProviderClient(
          module,
          "@google/generative-ai",
          ["GoogleGenerativeAI"],
          ["offline"],
        ),
      ),
    ],
  }),
  defineCaptureFamily({
    name: "openai",
    moduleName: "openai",
    packageNames: ["openai"],
    shapeKeys: ["openai-azure", "openai-native"],
    build: (module: ProviderModule) => [
      builtShape(
        "openai-azure",
        constructProviderClient(
          module,
          "openai",
          ["AzureOpenAI"],
          [
            {
              apiKey: "offline",
              endpoint: "https://offline.invalid",
              apiVersion: "2024-06-01",
            },
          ],
        ),
      ),
      builtShape(
        "openai-native",
        constructProviderClient(
          module,
          "openai",
          ["default", "OpenAI"],
          [{ apiKey: "sk-offline" }],
        ),
      ),
    ],
  }),
  defineCaptureFamily({
    name: "together",
    moduleName: "together-ai",
    packageNames: ["together-ai"],
    shapeKeys: ["together-native"],
    build: (module: ProviderModule) => [
      builtShape(
        "together-native",
        constructProviderClient(
          module,
          "together-ai",
          ["default", "Together"],
          [{ apiKey: "offline" }],
        ),
      ),
    ],
  }),
]);

function captureFamily(name: string): CaptureFamilyDefinition {
  const family = CAPTURE_FAMILIES.find((candidate) => candidate.name === name);
  if (family === undefined) {
    throw new Error(`unsupported capture family: ${name}`);
  }
  return family;
}

/** Dynamic provider import. Calling code owns installing the offline guard first. */
export async function importCaptureFamily(
  family: CaptureFamilyDefinition,
): Promise<ProviderModule> {
  const imported: unknown = await import(family.moduleName);
  if (!isRecord(imported)) {
    throw new Error(`provider module ${family.moduleName} did not expose a module namespace`);
  }
  return imported;
}

export interface CaptureArguments {
  readonly interval: string;
  readonly family?: CaptureFamilyName;
  readonly mode: "check" | "update";
  readonly outputDir: string;
}

function nextArgument(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseCaptureArgs(argv: readonly string[]): CaptureArguments {
  let interval: string | undefined;
  let family: CaptureFamilyName | undefined;
  let mode: "check" | "update" | undefined;
  let outputDir = DEFAULT_OUTPUT_DIRECTORY;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--interval") {
      if (interval !== undefined) throw new Error("--interval may be specified only once");
      interval = nextArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--family") {
      if (family !== undefined) throw new Error("--family may be specified only once");
      const value = nextArgument(argv, index, argument);
      family = captureFamily(value).name;
      index += 1;
      continue;
    }
    if (argument === "--output-dir") {
      outputDir = nextArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--check" || argument === "--update") {
      const nextMode = argument.slice(2) as "check" | "update";
      if (mode !== undefined) {
        throw new Error("exactly one of --check or --update is required");
      }
      mode = nextMode;
      continue;
    }
    throw new Error(`unsupported capture argument: ${argument}`);
  }
  if (interval === undefined) throw new Error("--interval is required");
  if (!INTERVAL_PATTERN.test(interval)) {
    throw new Error("structural_interval must be a lowercase path-safe label");
  }
  if (mode === undefined) throw new Error("exactly one of --check or --update is required");
  return family === undefined
    ? { interval, mode, outputDir }
    : { interval, family, mode, outputDir };
}

export async function findInstalledPackageMetadata(
  entryPath: string,
  packageName: string,
): Promise<DistributionRow> {
  let current = dirname(entryPath);
  while (true) {
    const candidate = join(current, "package.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(candidate, "utf8"));
      if (
        isRecord(parsed) &&
        parsed["name"] === packageName &&
        typeof parsed["version"] === "string" &&
        parsed["version"].length > 0
      ) {
        return { name: packageName, version: parsed["version"] };
      }
    } catch (error) {
      if (!isMissingFile(error) && error instanceof SyntaxError) {
        throw new Error(`invalid package metadata: ${candidate}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not locate package metadata for ${packageName}`);
}

export async function resolveInstalledPackageMetadata(
  packageName: string,
): Promise<DistributionRow> {
  const entryUrl = import.meta.resolve(packageName);
  return findInstalledPackageMetadata(fileURLToPath(entryUrl), packageName);
}

function encodedObservationShape(observation: {
  readonly descriptorCategory: DescriptorCategory;
  readonly returnShape: ReturnShape;
}): string {
  return `${observation.descriptorCategory}:${observation.returnShape}`;
}

export function recordSocketAttemptDelta(
  reports: readonly SurfaceInventoryReport[],
  guard: OfflineGuardHandle,
  attemptsAtStart: number,
): readonly SurfaceInventoryReport[] {
  const socketAttempts = guard.socketAttempts() - attemptsAtStart;
  if (socketAttempts < 0) {
    throw new Error("offline guard socket-attempt counter moved backward");
  }
  return reports.map((report) => normalizeReport({ ...report, socket_attempts: socketAttempts }));
}

export async function captureSurfaceReports(options: {
  readonly interval: string;
  readonly families: readonly CaptureFamilyDefinition[];
  readonly guard: OfflineGuardHandle;
  readonly attemptsAtStart: number;
  readonly nodeVersion?: string;
  readonly importFamily?: typeof importCaptureFamily;
}): Promise<readonly SurfaceInventoryReport[]> {
  if (!INTERVAL_PATTERN.test(options.interval)) {
    throw new Error("structural_interval must be a lowercase path-safe label");
  }

  const loaded = await Promise.all(
    options.families.map(async (family) => ({
      family,
      module: await (options.importFamily ?? importCaptureFamily)(family),
    })),
  );
  const built = loaded.flatMap(({ family, module }) =>
    family.build(module).map((shape) => ({ family, shape })),
  );
  const distributions = new Map<CaptureFamilyName, readonly DistributionRow[]>();
  for (const { family } of loaded) {
    distributions.set(
      family.name,
      await Promise.all(family.packageNames.map(resolveInstalledPackageMetadata)),
    );
  }

  const reports: SurfaceInventoryReport[] = [];
  for (const { family, shape } of built.sort((left, right) =>
    compareText(left.shape.shapeKey, right.shape.shapeKey),
  )) {
    const metadata = shapeMetadata(shape.shapeKey);
    const baseline = await loadBaselineFile(
      join(BASELINE_DIRECTORY, `${shape.shapeKey}.json`),
      shape.shapeKey,
    );
    const reviewed = observeReviewedPublicSurface(shape.client, {
      context: metadata.context,
      baselineRows: baseline.rows,
    });
    reports.push({
      schema_version: SCHEMA_VERSION,
      shape_key: shape.shapeKey,
      client_shape: metadata.context.clientShape,
      provider: metadata.context.provider ?? family.name,
      variant: metadata.variant,
      structural_interval: options.interval,
      distributions: distributions.get(family.name) ?? [],
      node_version: options.nodeVersion ?? process.versions.node,
      socket_attempts: 0,
      namespaces: reviewed.namespaces,
      observations: reviewed.observations.map((observation) => [
        observation.path,
        encodedObservationShape(observation),
      ]),
      command_classes: shape.commandClasses,
    });
  }

  return recordSocketAttemptDelta(reports, options.guard, options.attemptsAtStart);
}

function renderPrettyJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export function reportFilename(
  report: Pick<SurfaceInventoryReport, "shape_key" | "structural_interval">,
): string {
  return `${report.shape_key}@${report.structural_interval}.json`;
}

async function writeSurfaceReports(
  reports: readonly SurfaceInventoryReport[],
  outputDirectory: string,
): Promise<readonly string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const paths: string[] = [];
  for (const report of [...reports].sort((left, right) =>
    compareCells(fingerprintCell(left), fingerprintCell(right)),
  )) {
    const path = join(outputDirectory, reportFilename(report));
    await writeFile(path, renderPrettyJson(normalizeReport(report)), "utf8");
    paths.push(path);
  }
  return paths;
}

async function loadFingerprintManifest(path: string): Promise<FingerprintManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { schema_version: SCHEMA_VERSION, fingerprints: [] };
    }
    throw error;
  }
  return fingerprintManifestSchema.parse(JSON.parse(text)) as FingerprintManifest;
}

async function writeFingerprintManifest(
  path: string,
  manifest: FingerprintManifest,
): Promise<void> {
  const normalized = mergeFingerprintManifest(manifest, []);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderPrettyJson(normalized), "utf8");
}

function selectedCellsFor(
  families: readonly CaptureFamilyDefinition[],
  interval: string,
): readonly FingerprintCell[] {
  return families
    .flatMap((family) => family.shapeKeys.map((shapeKey) => [shapeKey, interval] as const))
    .sort(compareCells);
}

export interface CaptureRunResult {
  readonly reportPaths: readonly string[];
  readonly findings: readonly string[];
  readonly reports: readonly SurfaceInventoryReport[];
}

export interface CaptureExecutionDependencies {
  readonly importFamily?: typeof importCaptureFamily;
}

/** Execute one guarded capture after the caller has parsed and validated CLI arguments. */
export async function executeCapture(
  arguments_: CaptureArguments,
  dependencies: CaptureExecutionDependencies = {},
): Promise<CaptureRunResult> {
  const guard = installOfflineGuard();
  const attemptsAtStart = guard.socketAttempts();
  const families =
    arguments_.family === undefined ? CAPTURE_FAMILIES : [captureFamily(arguments_.family)];
  const reports = await captureSurfaceReports({
    interval: arguments_.interval,
    families,
    guard,
    attemptsAtStart,
    importFamily: dependencies.importFamily,
  });
  const reportPaths = await writeSurfaceReports(reports, arguments_.outputDir);
  const findings: string[] = [];
  if (reports.some((report) => report.socket_attempts !== 0)) {
    findings.push("report socket_attempts must be zero");
  }

  const manifest = await loadFingerprintManifest(FINGERPRINT_MANIFEST_PATH);
  if (arguments_.mode === "check") {
    findings.push(
      ...compareFingerprints({
        manifest,
        reports,
        selectedCells: selectedCellsFor(families, arguments_.interval),
      }),
    );
    for (const report of reports) {
      const baseline = await loadBaselineFile(
        join(BASELINE_DIRECTORY, `${report.shape_key}.json`),
        report.shape_key,
      );
      findings.push(...reviewedCoverageFindings(report, baseline.rows));
    }
  } else if (findings.length === 0) {
    await writeFingerprintManifest(
      FINGERPRINT_MANIFEST_PATH,
      mergeFingerprintManifest(manifest, reports.map(fingerprintReport)),
    );
    for (const report of reports) {
      await updateBaselineFile(
        join(BASELINE_DIRECTORY, `${report.shape_key}.json`),
        report.shape_key,
        baselineRowsForReport(report),
      );
    }
  }

  return {
    reportPaths,
    findings: [...new Set(findings)],
    reports,
  };
}

export function isMainModule(metaUrl = import.meta.url, argvEntry = process.argv[1]): boolean {
  if (argvEntry === undefined) return false;
  try {
    const entryPath = argvEntry.startsWith("file:") ? fileURLToPath(argvEntry) : resolve(argvEntry);
    return resolve(fileURLToPath(metaUrl)) === entryPath;
  } catch {
    return false;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const arguments_ = parseCaptureArgs(argv);
  const result = await executeCapture(arguments_);
  for (const finding of result.findings) {
    console.error(finding);
  }
  return result.findings.length === 0 ? 0 : 1;
}

if (isMainModule()) {
  void main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(renderCaptureFailure(error));
      process.exitCode = 1;
    });
}
