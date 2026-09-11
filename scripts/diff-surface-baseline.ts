import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BASELINE_DIRECTORY,
  type BaselineDocument,
  baselineDocumentSchema,
  CAPTURE_FAMILIES,
  isMainModule,
  REPOSITORY_ROOT,
} from "./capture-surface-inventory";

const execFileAsync = promisify(execFile);
const USAGE = "usage: pnpm surfaces:diff <base-ref>";

export interface SurfaceBaselineDiffInput {
  readonly shapeKey: string;
  readonly base?: unknown;
  readonly current: unknown;
}

interface SurfaceBaselineDelta {
  readonly shapeKey: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly shapeChanged: readonly string[];
}

function formatDiagnostic(value: string): string {
  let formatted = "";
  for (const character of value) {
    const codeUnit = character.charCodeAt(0);
    const mustEscape =
      codeUnit <= 0x1f ||
      (codeUnit >= 0x7f && codeUnit <= 0x9f) ||
      codeUnit === 0x2028 ||
      codeUnit === 0x2029;
    formatted += mustEscape ? `\\u${codeUnit.toString(16).padStart(4, "0")}` : character;
  }
  return formatted;
}

function invalidDocumentError(source: string, cause: unknown): Error {
  return new Error(`invalid baseline document: ${formatDiagnostic(source)}`, { cause });
}

function parseDocument(value: unknown, shapeKey: string, source = shapeKey): BaselineDocument {
  let document: BaselineDocument;
  try {
    document = baselineDocumentSchema.parse(value) as BaselineDocument;
  } catch (error) {
    throw invalidDocumentError(source, error);
  }
  if (document.shape_key !== shapeKey) {
    throw new Error(`baseline shape key mismatch: ${formatDiagnostic(shapeKey)}`);
  }
  return document;
}

function parseDocumentJson(text: string, shapeKey: string, source: string): BaselineDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalidDocumentError(source, error);
  }
  return parseDocument(value, shapeKey, source);
}

function baselineRelativePath(shapeKey: string): string {
  return `tests/surface-baseline/${shapeKey}.json`;
}

function shapeMap(document: BaselineDocument): ReadonlyMap<string, readonly string[]> {
  const rows = new Map<string, readonly string[]>();
  for (const [path, shapes] of document.rows) {
    if (rows.has(path)) {
      throw new Error(`duplicate baseline path: ${formatDiagnostic(path)}`);
    }
    rows.set(path, [...new Set(shapes)].sort());
  }
  return rows;
}

function sameShapes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((shape, index) => shape === right[index]);
}

function compareSurfaceBaseline(input: SurfaceBaselineDiffInput): SurfaceBaselineDelta {
  const current = shapeMap(parseDocument(input.current, input.shapeKey));
  const base =
    input.base === undefined
      ? new Map<string, readonly string[]>()
      : shapeMap(parseDocument(input.base, input.shapeKey));
  const added = [...current.keys()].filter((path) => !base.has(path)).sort();
  const removed = [...base.keys()].filter((path) => !current.has(path)).sort();
  const shapeChanged = [...current.keys()]
    .filter((path) => {
      const oldShapes = base.get(path);
      return oldShapes !== undefined && !sameShapes(oldShapes, current.get(path) ?? []);
    })
    .sort()
    .map(
      (path) =>
        `${path} ${(base.get(path) ?? []).join("|")} -> ${(current.get(path) ?? []).join("|")}`,
    );
  return { shapeKey: input.shapeKey, added, removed, shapeChanged };
}

function renderPaths(label: string, paths: readonly string[]): string {
  return paths.length === 0
    ? `${label} (0)`
    : `${label} (${paths.length}): ${paths.map(formatDiagnostic).join(", ")}`;
}

/** Validate, compare, and render deterministic per-shape surface baseline deltas. */
export function renderSurfaceBaselineDiff(inputs: readonly SurfaceBaselineDiffInput[]): string {
  const deltas = inputs
    .map(compareSurfaceBaseline)
    .filter(
      (delta) =>
        delta.added.length > 0 || delta.removed.length > 0 || delta.shapeChanged.length > 0,
    )
    .sort((left, right) =>
      left.shapeKey < right.shapeKey ? -1 : left.shapeKey > right.shapeKey ? 1 : 0,
    );
  if (deltas.length === 0) return "no surface delta\n";

  const lines: string[] = [];
  for (const delta of deltas) {
    lines.push(`${formatDiagnostic(delta.shapeKey)}  ${renderPaths("added", delta.added)}`);
    lines.push(renderPaths("removed", delta.removed));
    lines.push(renderPaths("shape-changed", delta.shapeChanged));
  }
  return `${lines.join("\n")}\n`;
}

export function parseSurfaceDiffArguments(argv: readonly string[]): string {
  if (argv.length !== 1 || argv[0] === undefined || argv[0].length === 0) {
    throw new Error(USAGE);
  }
  return argv[0];
}

async function resolveBaseCommit(baseRef: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(`invalid base ref: ${formatDiagnostic(baseRef)}`, { cause: error });
  }
}

async function loadBaseDocument(
  baseCommit: string,
  shapeKey: string,
  availablePaths: ReadonlySet<string>,
): Promise<BaselineDocument | undefined> {
  const relativePath = baselineRelativePath(shapeKey);
  if (!availablePaths.has(relativePath)) return undefined;

  const { stdout } = await execFileAsync(
    "git",
    ["show", "--end-of-options", `${baseCommit}:${relativePath}`],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  return parseDocumentJson(stdout, shapeKey, relativePath);
}

async function listBaseDocumentPaths(
  baseCommit: string,
  shapeKeys: readonly string[],
): Promise<ReadonlySet<string>> {
  const relativePaths = shapeKeys.map(baselineRelativePath);
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-z", "--name-only", "--full-tree", baseCommit, "--", ...relativePaths],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  return new Set(stdout.split("\0").filter((path) => path.length > 0));
}

async function loadCurrentDocument(shapeKey: string): Promise<BaselineDocument> {
  const path = join(BASELINE_DIRECTORY, `${shapeKey}.json`);
  return parseDocumentJson(await readFile(path, "utf8"), shapeKey, baselineRelativePath(shapeKey));
}

export async function executeSurfaceBaselineDiff(baseRef: string): Promise<string> {
  const baseCommit = await resolveBaseCommit(baseRef);
  const shapeKeys = [
    ...new Set(CAPTURE_FAMILIES.flatMap((family) => [...family.shapeKeys])),
  ].sort();
  const availableBasePaths = await listBaseDocumentPaths(baseCommit, shapeKeys);
  const inputs = await Promise.all(
    shapeKeys.map(async (shapeKey) => {
      const [base, current] = await Promise.all([
        loadBaseDocument(baseCommit, shapeKey, availableBasePaths),
        loadCurrentDocument(shapeKey),
      ]);
      return { shapeKey, base, current };
    }),
  );
  return renderSurfaceBaselineDiff(inputs);
}

export async function main(argv: readonly string[]): Promise<void> {
  process.stdout.write(await executeSurfaceBaselineDiff(parseSurfaceDiffArguments(argv)));
}

if (isMainModule(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "surface baseline diff failed");
    process.exitCode = 1;
  });
}
