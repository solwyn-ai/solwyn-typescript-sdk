import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = fileURLToPath(new URL("../../scripts/run-provider-surfaces.mjs", import.meta.url));
const intervals = [
  { family: "anthropic", interval: "floor", packages: ["@anthropic-ai/sdk@0.30.0"] },
  { family: "anthropic", interval: "latest", packages: ["@anthropic-ai/sdk@0.135.0"] },
  { family: "openai", interval: "floor", packages: ["openai@4.41.0"] },
];

interface RecordEntry {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly family?: string;
  readonly overlay?: readonly string[];
}

function executeIntervals(options: { readonly fail?: string; readonly input?: string } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "provider intervals "));
  const root = join(scratch, "repo");
  const bin = join(scratch, "bin");
  const trace = join(scratch, "trace.jsonl");
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(runner, join(root, "scripts", "run-provider-surfaces.mjs"));
    writeFileSync(join(root, "package.json"), '{"name":"synthetic","private":true}');
    writeFileSync(join(root, "pnpm-lock.yaml"), "synthetic lockfile\n");
    expect(spawnSync("git", ["init", "--quiet", root]).status).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
    const pnpm = join(bin, "pnpm");
    writeFileSync(
      pnpm,
      String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
appendFileSync(process.env.TRACE_FILE, JSON.stringify({ cwd: process.cwd(), args,
  family: process.env.SOLWYN_SURFACE_CANARY_FAMILY, overlay: manifest.overlay }) + "\n");
if (args[0] === "install") {
  if (manifest.overlay || existsSync("node_modules")) process.exit(98);
  mkdirSync("node_modules");
} else if (args[0] === "add") {
  manifest.overlay = args.slice(3);
  writeFileSync("package.json", JSON.stringify(manifest));
  if (process.env.FAIL_STAGE === "overlay") process.exit(2);
  if (process.env.FAIL_STAGE === "lockfile") writeFileSync("pnpm-lock.yaml", "changed");
} else if (args[0] === "tsx") {
  const out = args[args.indexOf("--output-dir") + 1];
  mkdirSync(out, { recursive: true });
  writeFileSync(out + "/report.json", JSON.stringify(manifest.overlay));
  if (process.env.FAIL_STAGE === "checks" && manifest.overlay[0].endsWith("0.30.0")) process.exit(3);
} else if (args[0] === "vitest") {
  if (process.env.FAIL_STAGE === "checks" && manifest.overlay[0].endsWith("0.135.0")) process.exit(4);
} else { process.exit(99); }
`,
    );
    // The executable has no extension; opt into ESM through its parent manifest.
    writeFileSync(join(bin, "package.json"), '{"type":"module"}');
    chmodSync(pnpm, 0o755);
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "run-provider-surfaces.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"]}`,
          SURFACE_INTERVALS: options.input ?? JSON.stringify(intervals),
          TRACE_FILE: trace,
          FAIL_STAGE: options.fail ?? "",
        },
      },
    );
    const records: readonly RecordEntry[] = existsSync(trace)
      ? readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return {
      ...result,
      records,
      cleaned: records.every((record) => !existsSync(record.cwd)),
      manifest: readFileSync(join(root, "package.json"), "utf8"),
      lockfile: readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
      reports: intervals.map(({ family, interval }) => {
        const path = join(
          root,
          "build",
          "provider-surface-inventory",
          `${family}-${interval}`,
          "report.json",
        );
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
      }),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("consolidated provider surface runner", () => {
  it("checks every interval in a fresh install and retains its reports after cleanup", () => {
    const result = executeIntervals();
    expect(result.status, result.stderr).toBe(0);
    expect(new Set(result.records.map(({ cwd }) => cwd)).size).toBe(3);
    expect(result.records.filter(({ args }) => args[0] === "install")).toHaveLength(3);
    expect(
      result.records.filter(({ args }) => args[0] === "tsx").map(({ overlay }) => overlay),
    ).toEqual([["@anthropic-ai/sdk@0.30.0"], ["@anthropic-ai/sdk@0.135.0"], ["openai@4.41.0"]]);
    expect(
      result.records.filter(({ args }) => args[0] === "vitest").map(({ family }) => family),
    ).toEqual(["anthropic", "anthropic", "openai"]);
    expect(result.reports).toEqual(intervals.map(({ packages }) => packages));
    expect(result.cleaned).toBe(true);
    expect(result.manifest).toBe('{"name":"synthetic","private":true}');
    expect(result.lockfile).toBe("synthetic lockfile\n");
    expect(result.stdout.match(/::group::/g)).toHaveLength(3);
    expect(result.stdout.match(/::endgroup::/g)).toHaveLength(3);
  });

  it("runs all remaining captures and canaries and names every failed interval", () => {
    const result = executeIntervals({ fail: "checks" });
    expect(result.status).toBe(1);
    expect(result.records.filter(({ args }) => args[0] === "vitest")).toHaveLength(3);
    expect(result.records.filter(({ args }) => args[0] === "tsx")).toHaveLength(3);
    expect(result.stderr).toContain("anthropic / floor: capture");
    expect(result.stderr).toContain("anthropic / latest: canary");
    expect(result.reports[2]).toEqual(["openai@4.41.0"]);
    expect(result.cleaned).toBe(true);
  });

  it.each([
    "overlay",
    "lockfile",
  ])("fails all affected intervals on %s errors and still attempts each canary", (fail) => {
    const result = executeIntervals({ fail });
    expect(result.status).toBe(1);
    for (const { family, interval } of intervals) {
      expect(result.stderr).toContain(`${family} / ${interval}: ${fail}`);
    }
    expect(result.records.filter(({ args }) => args[0] === "vitest")).toHaveLength(3);
    expect(result.records.filter(({ args }) => args[0] === "tsx")).toHaveLength(0);
    expect(result.cleaned).toBe(true);
  });

  it.each([
    "[]",
    "{}",
    '[{"family":"openai","interval":"floor","packages":[]}]',
  ])("rejects a missing or empty interval selection: %s", (input) => {
    const result = executeIntervals({ input });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SURFACE_INTERVALS must contain nonempty provider intervals");
    expect(result.records).toHaveLength(0);
  });
});
