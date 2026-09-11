import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseSurfaceDiffArguments,
  renderSurfaceBaselineDiff,
} from "../../scripts/diff-surface-baseline";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/diff-surface-baseline.ts", import.meta.url),
);

function baseline(shapeKey: string, rows: readonly (readonly [string, readonly string[]])[]) {
  return { schema_version: 1 as const, shape_key: shapeKey, rows };
}

function runGit(args: readonly string[], cwd: string, env = process.env): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0] ?? "command"} failed`);
  }
}

function runScript(args: readonly string[], env = process.env) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env,
  });
}

describe("surface baseline delta renderer", () => {
  it("renders sorted additions, removals, and accepted-shape changes", () => {
    const output = renderSurfaceBaselineDiff([
      {
        shapeKey: "openai-native",
        base: baseline("openai-native", [
          ["audio.speech", ["getter:resource"]],
          ["obsolete", ["method:function"]],
        ]),
        current: baseline("openai-native", [
          ["responses.parse", ["method:function"]],
          ["audio.speech", ["getter:opaque"]],
          ["realtime", ["field:resource"]],
        ]),
      },
    ]);

    expect(output).toBe(
      "openai-native  added (2): realtime, responses.parse\n" +
        "removed (1): obsolete\n" +
        "shape-changed (1): audio.speech getter:resource -> getter:opaque\n",
    );
  });

  it("treats a missing base document as an empty shape", () => {
    expect(
      renderSurfaceBaselineDiff([
        {
          shapeKey: "bedrock-v3",
          current: baseline("bedrock-v3", [
            ["ZuluCommand", ["command_class:command_class"]],
            ["AlphaCommand", ["command_class:command_class"]],
          ]),
        },
      ]),
    ).toBe(
      "bedrock-v3  added (2): AlphaCommand, ZuluCommand\n" +
        "removed (0)\n" +
        "shape-changed (0)\n",
    );
  });

  it("sorts shape sections and renders no overall delta exactly", () => {
    const unchanged = baseline("zeta", [["same", ["field:scalar"]]]);
    expect(
      renderSurfaceBaselineDiff([
        { shapeKey: "zeta", base: unchanged, current: unchanged },
        {
          shapeKey: "alpha",
          base: baseline("alpha", []),
          current: baseline("alpha", [["new", ["field:scalar"]]]),
        },
      ]),
    ).toBe("alpha  added (1): new\nremoved (0)\nshape-changed (0)\n");
    expect(
      renderSurfaceBaselineDiff([{ shapeKey: "zeta", base: unchanged, current: unchanged }]),
    ).toBe("no surface delta\n");
  });

  it("escapes terminal controls in rendered paths and shape changes", () => {
    expect(
      renderSurfaceBaselineDiff([
        {
          shapeKey: "openai-native",
          base: baseline("openai-native", [["changed\n\u001bFORGED", ["field:scalar"]]]),
          current: baseline("openai-native", [
            ["added\u007f\u0080\u009f\u2028\u2029", ["field:scalar"]],
            ["changed\n\u001bFORGED", ["getter:resource"]],
          ]),
        },
      ]),
    ).toBe(
      "openai-native  added (1): added\\u007f\\u0080\\u009f\\u2028\\u2029\n" +
        "removed (0)\n" +
        "shape-changed (1): changed\\u000a\\u001bFORGED field:scalar -> getter:resource\n",
    );
  });

  it("escapes terminal controls in duplicate-path errors", () => {
    const duplicatePath = "duplicate\n\u001bFORGED";
    expect(() =>
      renderSurfaceBaselineDiff([
        {
          shapeKey: "openai-native",
          current: baseline("openai-native", [
            [duplicatePath, ["field:scalar"]],
            [duplicatePath, ["getter:resource"]],
          ]),
        },
      ]),
    ).toThrow("duplicate baseline path: duplicate\\u000a\\u001bFORGED");
  });

  it("wraps schema failures without reflecting control-bearing payloads", () => {
    let thrown: unknown;
    try {
      renderSurfaceBaselineDiff([
        {
          shapeKey: "openai-native",
          current: baseline("openai-native", [["safe", ["field:scalar\n\u001bFORGED"]]]),
        },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("invalid baseline document: openai-native");
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("fails loudly for invalid strict documents and mismatched shape keys", () => {
    expect(() =>
      renderSurfaceBaselineDiff([
        {
          shapeKey: "openai-native",
          current: { ...baseline("openai-native", []), unexpected: true },
        },
      ]),
    ).toThrow();
    expect(() =>
      renderSurfaceBaselineDiff([
        {
          shapeKey: "openai-native",
          current: baseline("openai-azure", []),
        },
      ]),
    ).toThrow("baseline shape key mismatch: openai-native");
  });
});

describe("surface baseline diff arguments", () => {
  it.each([[[]], [["main", "extra"]]])("requires exactly one base ref for %j", (argv) => {
    expect(() => parseSurfaceDiffArguments(argv)).toThrow("usage: pnpm surfaces:diff <base-ref>");
  });

  it("accepts one nonempty base ref", () => {
    expect(parseSurfaceDiffArguments(["refs/remotes/origin/main"])).toBe(
      "refs/remotes/origin/main",
    );
  });

  it("rejects Git index syntax even when the stage-zero baseline exists", () => {
    const indexedFixture = spawnSync(
      "git",
      ["show", "--end-of-options", ":0:tests/surface-baseline/openai-native.json"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    expect(indexedFixture.status).toBe(0);
    expect(indexedFixture.stdout).toContain('"shape_key": "openai-native"');

    const result = runScript([":0"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("invalid base ref: :0");
  });

  it("escapes terminal controls in invalid base-ref diagnostics", () => {
    const result = runScript(["missing\n\u001bFORGED"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("invalid base ref: missing\\u000a\\u001bFORGED");
  });

  it("wraps malformed historical JSON in a stable path-only diagnostic", () => {
    const gitRepository = mkdtempSync(join(tmpdir(), "solwyn-surface-diff-"));
    try {
      const relativePath = "tests/surface-baseline/openai-native.json";
      const fixturePath = join(gitRepository, relativePath);
      const gitEnvironment = {
        ...process.env,
        GIT_AUTHOR_NAME: "Surface Diff Test",
        GIT_AUTHOR_EMAIL: "surface-diff@example.invalid",
        GIT_COMMITTER_NAME: "Surface Diff Test",
        GIT_COMMITTER_EMAIL: "surface-diff@example.invalid",
      };
      runGit(["init", "--quiet"], gitRepository, gitEnvironment);
      mkdirSync(join(gitRepository, "tests/surface-baseline"), { recursive: true });
      writeFileSync(fixturePath, '{"forged":"\n\u001bFORGED"', "utf8");
      runGit(["add", relativePath], gitRepository, gitEnvironment);
      runGit(["commit", "--quiet", "-m", "malformed baseline"], gitRepository, gitEnvironment);

      const result = runScript(["HEAD"], {
        ...gitEnvironment,
        GIT_DIR: join(gitRepository, ".git"),
        GIT_WORK_TREE: gitRepository,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(`invalid baseline document: ${relativePath}`);
    } finally {
      rmSync(gitRepository, { recursive: true, force: true });
    }
  });

  it("runs the actual ESM entry point and reports usage when the base ref is absent", () => {
    const result = runScript([]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("usage: pnpm surfaces:diff <base-ref>");
  });
});
