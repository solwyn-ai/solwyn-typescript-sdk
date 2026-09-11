import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCANNER_PATH = fileURLToPath(
  new URL("../../scripts/check-public-surface.mjs", import.meta.url),
);

interface ScannerResult {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

function runGit(root: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function writeFixture(root: string, relativePath: string, contents: string): void {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}

function writeSourceMapReference(root: string, relativePath: string, reference: string): void {
  const directive = ["//", "#", "sourceMappingURL", "="].join("");
  writeFixture(root, relativePath, `${directive}${reference}\n`);
}

function writeBlockSourceMapReference(root: string, relativePath: string, reference: string): void {
  const directive = ["/", "*", "#", " sourceMappingURL", "="].join("");
  writeFixture(root, relativePath, `${directive}${reference} */\n`);
}

function runScanner(
  root: string,
  args: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): ScannerResult {
  try {
    const stdout = execFileSync(process.execPath, [SCANNER_PATH, ...args], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "", stdout };
  } catch (cause) {
    const failure = cause as {
      readonly status?: number;
      readonly stderr?: Buffer | string;
      readonly stdout?: Buffer | string;
    };
    return {
      status: failure.status ?? -1,
      stderr: failure.stderr?.toString() ?? "",
      stdout: failure.stdout?.toString() ?? "",
    };
  }
}

function stageMaterializedSymlink(root: string, relativePath: string, target: string): void {
  runGit(root, ["config", "core.symlinks", "false"]);
  writeFixture(root, relativePath, target);
  const objectId = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: target,
  }).trim();
  runGit(root, ["update-index", "--add", "--cacheinfo", `120000,${objectId},${relativePath}`]);
}

function withRepository(run: (repositoryRoot: string, fixtureRoot: string) => void): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "solwyn-public-surface-"));
  const repositoryRoot = join(fixtureRoot, "repository");
  mkdirSync(repositoryRoot);
  runGit(repositoryRoot, ["init", "--quiet"]);

  try {
    run(repositoryRoot, fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

describe("public surface scanner CLI", () => {
  it("rejects private material in a novel untracked HTML directory", () => {
    withRepository((root) => {
      const privatePath = ["docs", "reviews", "launch.html"].join("/");
      writeFixture(root, "site-preview/generated/report.html", `See ${privatePath}\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "site-preview/generated/report.html:1: prohibited internal path",
      );
    });
  });

  it("rejects a missing repository-relative Markdown target", () => {
    withRepository((root) => {
      writeFixture(root, "guides/start.md", "Read the [setup guide](./missing/setup.md).\n");
      runGit(root, ["add", "guides/start.md"]);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "guides/start.md:1: missing repository-relative Markdown target",
      );
      expect(result.stderr).not.toContain("guides/missing/setup.md");
    });
  });

  it("rejects a missing reference-style Markdown target", () => {
    withRepository((root) => {
      writeFixture(
        root,
        "README.md",
        "Read the [setup guide][setup].\n\n[setup]: guides/missing.md\n",
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:3: missing repository-relative Markdown target");
      expect(result.stderr).not.toContain("guides/missing.md");
    });
  });

  it("accepts a balanced CommonMark destination containing parentheses", () => {
    withRepository((root) => {
      writeFixture(root, "guide_(old).md", "# Archived guide\n");
      writeFixture(
        root,
        "README.md",
        "Read the [old guide](guide_(old).md) or [angle form](<guide_(old).md>).\n",
      );

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("rejects a missing link with a nested Markdown label", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "Read [outer [inner]](missing.md).\n");

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:1: missing repository-relative Markdown target");
    });
  });

  it.each([
    ["an exact two-backtick span", "``handlers[`name`](payload)``\n", 0],
    ["an escaped backtick", "\\`[guide](missing.md)\\`\n", 1],
    ["a mismatched longer closing run", "``[guide](missing.md)```\n", 1],
    ["overlapping delimiter runs", "`a `` b` [guide](missing.md) ``\n", 1],
  ])("handles links around %s", (_caseName, markdown, expectedStatus) => {
    withRepository((root) => {
      writeFixture(root, "README.md", markdown);

      const result = runScanner(root);

      expect(result.status).toBe(expectedStatus);
      if (expectedStatus === 1) {
        expect(result.stderr).toContain("README.md:1: missing repository-relative Markdown target");
      } else expect(result.stderr).toBe("");
    });
  });

  it("ignores links in an indented CommonMark code block", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "    handlers[name](payload);\n");

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("checks links in CommonMark list continuation indentation", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "- Resources\n    [guide](missing.md)\n");

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:2: missing repository-relative Markdown target");
    });
  });

  it("rejects a missing pointy destination followed by a title", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", '[guide](<missing.md> "title")\n');

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:1: missing repository-relative Markdown target");
    });
  });

  it("rejects a missing multiline CommonMark destination", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "[guide](\n  missing.md\n)\n");

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:1: missing repository-relative Markdown target");
    });
  });

  it.each([
    ["link", "missing"],
    ["link", "file URL"],
    ["image", "missing"],
    ["image", "file URL"],
  ])("checks a multiline CommonMark %s label with a %s target", (labelKind, targetKind) => {
    withRepository((root) => {
      const target =
        targetKind === "missing" ? "missing.md" : `file://${["", "etc", "passwd"].join("/")}`;
      const prefix = labelKind === "image" ? "!" : "";
      writeFixture(root, "README.md", `${prefix}[local\nfile](${target})\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        targetKind === "missing"
          ? "README.md:2: missing repository-relative Markdown target"
          : "README.md:2: prohibited file URL Markdown target",
      );
      expect(result.stderr).not.toContain("passwd");
    });
  });

  it("scans a long blank Markdown document within a bounded time", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "\n".repeat(32 * 1024));

      const startedAt = process.hrtime.bigint();
      const result = runScanner(root);
      const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      expect(result.status).toBe(0);
      expect(elapsedMilliseconds).toBeLessThan(2_000);
    });
  }, 15_000);

  it("scans many unclosed Markdown destinations within a bounded time", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "[x](".repeat(40 * 1024));

      const startedAt = process.hrtime.bigint();
      const result = runScanner(root);
      const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      expect(result.status).toBe(0);
      expect(elapsedMilliseconds).toBeLessThan(2_000);
    });
  }, 15_000);

  it("does not treat a backtick fence with backticks in its info string as code", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "```ts`invalid\n[guide](missing.md)\n");

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:2: missing repository-relative Markdown target");
    });
  });

  it("rejects a Markdown target that exists only as an ignored file", () => {
    withRepository((root) => {
      writeFixture(root, ".gitignore", "private.md\n");
      writeFixture(root, "README.md", "Read the [private notes](private.md).\n");
      writeFixture(root, "private.md", "ignored\n");
      runGit(root, ["add", ".gitignore", "README.md"]);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "README.md:1: repository-relative Markdown target is outside the candidate surface",
      );
      expect(result.stderr).not.toContain("private.md: ignored");
    });
  });

  it("rejects a non-personal file URL Markdown target", () => {
    withRepository((root) => {
      const fileUrl = `file://${["", "etc", "passwd"].join("/")}`;
      writeFixture(root, "README.md", `Do not link [local files](${fileUrl}).\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:1: prohibited file URL Markdown target");
      expect(result.stderr).not.toContain("passwd");
    });
  });

  it.each([
    "autolink",
    "pointy link destination",
  ])("rejects a file URL in a Markdown %s", (form) => {
    withRepository((root) => {
      const fileUrl = `file://${["", "private", "path)withparen"].join("/")}`;
      const markdown = form === "autolink" ? `<${fileUrl}>\n` : `[local file](<${fileUrl}>)\n`;
      writeFixture(root, "README.md", markdown);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:1: prohibited file URL Markdown target");
      expect(result.stderr).not.toContain("path)withparen");
    });
  });

  it("rejects a prohibited percent-decoded Markdown destination before path normalization", () => {
    withRepository((root) => {
      const encodedPrivatePath = ["docs", "reviews"].join("%2F");
      writeFixture(root, "README.md", `[private](${encodedPrivatePath}/../../README.md)\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:1: prohibited signature in Markdown target");
      expect(result.stderr).not.toContain(encodedPrivatePath);
    });
  });

  it("checks raw HTML href and src targets", () => {
    withRepository((root) => {
      const fileUrl = `file://${["", "etc", "passwd"].join("/")}`;
      const encodedPrivatePath = ["docs", "reviews", "image.png"].join("%2F");
      writeFixture(
        root,
        "page.html",
        [
          '<a href="missing.html">missing</a>',
          `<a href="${fileUrl}">local</a>`,
          `<img src="${encodedPrivatePath}">`,
          "",
        ].join("\n"),
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("page.html:1: missing source-relative HTML target");
      expect(result.stderr).toContain("page.html:2: prohibited file URL HTML target");
      expect(result.stderr).toContain("page.html:3: prohibited signature in HTML target");
      expect(result.stderr).not.toContain("passwd");
      expect(result.stderr).not.toContain(encodedPrivatePath);
    });
  });

  it("decodes named, decimal, and hexadecimal HTML character references in targets", () => {
    withRepository((root) => {
      const encodedFileUrl = `file&#58;//${["", "etc", "passwd"].join("/")}`;
      const encodedPrivatePath = ["docs", "reviews", "image.png"].join("&#x2f;");
      writeFixture(root, "present.html", "<p>Public page</p>\n");
      writeFixture(
        root,
        "page.html",
        [
          '<a href="present&period;html">present</a>',
          `<a href="${encodedFileUrl}">local</a>`,
          `<img src="${encodedPrivatePath}">`,
          "",
        ].join("\n"),
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("page.html:1: missing source-relative HTML target");
      expect(result.stderr).toContain("page.html:2: prohibited file URL HTML target");
      expect(result.stderr).toContain("page.html:3: prohibited signature in HTML target");
      expect(result.stderr).not.toContain("passwd");
      expect(result.stderr).not.toContain(encodedPrivatePath);
    });
  });

  it.each([
    ["xlink:href", "missing.svg", "missing source-relative HTML target"],
    ["poster", "file", "prohibited file URL HTML target"],
    ["action", "policy", "prohibited signature in HTML target"],
    ["formaction", "missing-submit", "missing source-relative HTML target"],
    ["data", "file", "prohibited file URL HTML target"],
  ])("checks the %s raw HTML URL attribute", (attribute, targetKind, diagnostic) => {
    withRepository((root) => {
      const target =
        targetKind === "file"
          ? `file://${["", "etc", "passwd"].join("/")}`
          : targetKind === "policy"
            ? ["docs", "reviews", "private.html"].join("%2f")
            : targetKind;
      writeFixture(root, "page.html", `<element ${attribute}="${target}"></element>\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`page.html:1: ${diagnostic}`);
      expect(result.stderr).not.toContain(target);
    });
  });

  it("checks every candidate in a raw HTML srcset attribute", () => {
    withRepository((root) => {
      const fileUrl = `file://${["", "etc", "passwd"].join("/")}`;
      const encodedPrivatePath = ["docs", "reviews", "private.png"].join("%2f");
      writeFixture(root, "present.png", "public image placeholder\n");
      writeFixture(
        root,
        "page.html",
        `<img srcset="present.png 1x, missing.png 2x, ${fileUrl} 3x, ${encodedPrivatePath} 4x">\n`,
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("page.html:1: missing source-relative HTML target");
      expect(result.stderr).toContain("page.html:1: prohibited file URL HTML target");
      expect(result.stderr).toContain("page.html:1: prohibited signature in HTML target");
      expect(result.stderr).not.toContain("passwd");
      expect(result.stderr).not.toContain(encodedPrivatePath);
    });
  });

  it("checks raw HTML targets embedded in Markdown outside code", () => {
    withRepository((root) => {
      writeFixture(
        root,
        "README.md",
        [
          "```html",
          '<a href="ignored-missing.html">example</a>',
          "```",
          '<a href="missing.html">missing</a>',
          "",
        ].join("\n"),
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README.md:4: missing source-relative HTML target");
      expect(result.stderr).not.toContain("README.md:2: missing source-relative HTML target");
    });
  });

  it("ignores apparent raw HTML targets in script and textarea contents", () => {
    withRepository((root) => {
      writeFixture(
        root,
        "page.html",
        [
          "<script>",
          `const example = ${JSON.stringify('<a href="ignored-script.html">example</a>')};`,
          "</script>",
          '<textarea><img src="ignored-textarea.png"></textarea>',
          '<a href="missing.html">missing</a>',
          "",
        ].join("\n"),
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("page.html:5: missing source-relative HTML target");
      expect(result.stderr).not.toContain("page.html:2: missing source-relative HTML target");
      expect(result.stderr).not.toContain("page.html:4: missing source-relative HTML target");
    });
  });

  it("rejects a broken symlink", () => {
    withRepository((root) => {
      symlinkSync("missing.md", join(root, "BROKEN.md"));

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("BROKEN.md: broken symlink");
    });
  });

  it("applies indexed symlink semantics when the worktree materializes it as text", () => {
    withRepository((root) => {
      stageMaterializedSymlink(root, "MATERIALIZED.md", "missing.md");

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("MATERIALIZED.md: broken symlink");
    });
  });

  it.each([
    "native",
    "materialized index",
  ])("rejects an absolute in-root symlink target through the %s branch", (symlinkForm) => {
    withRepository((root) => {
      writeFixture(root, "README.md", "# Public\n");
      const absoluteTarget = join(root, "README.md");
      if (symlinkForm === "native") symlinkSync(absoluteTarget, join(root, "PUBLIC.md"));
      else stageMaterializedSymlink(root, "PUBLIC.md", absoluteTarget);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PUBLIC.md: absolute symlink target");
      expect(result.stderr).not.toContain(absoluteTarget);
    });
  });

  it("rejects a symlink target that exists only as an ignored file", () => {
    withRepository((root) => {
      writeFixture(root, ".gitignore", "ignored.md\n");
      writeFixture(root, "ignored.md", "ignored\n");
      symlinkSync("ignored.md", join(root, "PUBLIC.md"));
      runGit(root, ["add", ".gitignore", "PUBLIC.md"]);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PUBLIC.md: symlink target is outside the candidate surface");
    });
  });

  it("rejects a prohibited raw symlink target even when dot segments resolve safely", () => {
    withRepository((root) => {
      const privateDirectory = ["docs", "reviews"].join("/");
      mkdirSync(join(root, privateDirectory), { recursive: true });
      writeFixture(root, "README.md", "# Public\n");
      symlinkSync(`${privateDirectory}/../../README.md`, join(root, "PUBLIC.md"));

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PUBLIC.md: prohibited signature in symlink target");
    });
  });

  it("rejects an ignored intermediate symlink-resolution component", () => {
    withRepository((root) => {
      writeFixture(root, ".gitignore", "ignored/\n");
      writeFixture(root, "README.md", "# Public\n");
      writeFixture(root, "ignored/placeholder.txt", "ignored\n");
      symlinkSync("ignored/../README.md", join(root, "PUBLIC.md"));
      runGit(root, ["add", ".gitignore", "README.md", "PUBLIC.md"]);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "PUBLIC.md: symlink resolution component is outside the candidate surface",
      );
    });
  });

  it("rejects a symlink that escapes the scan root", () => {
    withRepository((root, fixtureRoot) => {
      writeFixture(fixtureRoot, "outside.md", "not part of the candidate\n");
      symlinkSync("../outside.md", join(root, "ESCAPE.md"));

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ESCAPE.md: symlink escapes scan root");
    });
  });

  it("rejects an indirect symlink chain that escapes the scan root", () => {
    withRepository((root, fixtureRoot) => {
      writeFixture(fixtureRoot, "outside.md", "not part of the candidate\n");
      symlinkSync("../outside.md", join(root, "middle.md"));
      symlinkSync("middle.md", join(root, "ENTRY.md"));

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ENTRY.md: symlink escapes scan root");
    });
  });

  it("rejects a prohibited source reference in a recursively scanned artifact", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeFixture(
        artifactRoot,
        "dist/chunks/index.js.map",
        JSON.stringify({
          version: 3,
          sources: [["", "Users", "release-engineer", "private-sdk", "src", "index.ts"].join("/")],
          names: [],
          mappings: "",
        }),
      );

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "dist/chunks/index.js.map:1: prohibited personal absolute path",
      );
    });
  });

  it.each([
    ["relative sources", undefined, ["../../outside.ts"]],
    ["relative sourceRoot", "../../outside", ["index.ts"]],
  ])("accepts benign %s outside a direct build-output root", (_caseName, sourceRoot, sources) => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeFixture(
        artifactRoot,
        "dist/index.js.map",
        JSON.stringify({ version: 3, sourceRoot, sources, names: [], mappings: "" }),
      );

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("rejects prohibited parsed sourcesContent even when its slash is JSON-escaped", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const privatePath = ["docs", "reviews"].join("/");
      const escapedPrivatePath = privatePath.replace("/", "\\/");
      const sourceMap = JSON.stringify({
        version: 3,
        sources: ["../src/index.ts"],
        sourcesContent: [`See ${privatePath}`],
        names: [],
        mappings: "",
      }).replace(privatePath, escapedPrivatePath);
      writeFixture(artifactRoot, "dist/index.js.map", sourceMap);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js.map:1: prohibited internal path");
    });
  });

  it("rejects prohibited sourcesContent nested in an indexed source map", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const privatePath = ["docs", "reviews"].join("/");
      const escapedPrivatePath = privatePath.replace("/", "\\/");
      const indexedMap = JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: {
              version: 3,
              sources: ["../src/index.ts"],
              sourcesContent: [`See ${privatePath}`],
              names: [],
              mappings: "",
            },
          },
        ],
      }).replace(privatePath, escapedPrivatePath);
      writeFixture(artifactRoot, "dist/index.js.map", indexedMap);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js.map:1: prohibited internal path");
    });
  });

  it("fails closed for excessively nested indexed source maps", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      let sourceMap: unknown = { version: 3, sources: [], names: [], mappings: "" };
      for (let depth = 0; depth < 65; depth += 1) {
        sourceMap = {
          version: 3,
          sections: [{ offset: { line: 0, column: 0 }, map: sourceMap }],
        };
      }
      writeFixture(artifactRoot, "dist/index.js.map", JSON.stringify(sourceMap));

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "dist/index.js.map: source map nesting exceeds the 64-level limit",
      );
    });
  });

  it("rejects file URLs in parsed source-map sources", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const fileSource = `file://${["", "tmp", "index.ts"].join("/")}`;
      writeFixture(
        artifactRoot,
        "dist/index.js.map",
        JSON.stringify({ version: 3, sources: [fileSource], names: [], mappings: "" }),
      );

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "dist/index.js.map: source map contains an absolute local source path",
      );
    });
  });

  it("rejects a personal path embedded in a URL-like sourceRoot", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const personalPath = ["", "Users", "release-engineer", "sdk"].join("/");
      writeFixture(
        artifactRoot,
        "dist/index.js.map",
        JSON.stringify({
          version: 3,
          sourceRoot: `webpack://${personalPath}`,
          sources: ["index.ts"],
          names: [],
          mappings: "",
        }),
      );

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js.map:1: prohibited personal absolute path");
    });
  });

  it.each([
    "unicode escape",
    "escaped slash",
  ])("rejects a prohibited string hidden in ordinary JSON with an %s", (encoding) => {
    withRepository((root) => {
      const privatePath = ["docs", "reviews"].join("/");
      const encodedPath =
        encoding === "unicode escape"
          ? ["docs", "reviews"].join("\\u002f")
          : privatePath.replace("/", "\\/");
      writeFixture(root, "metadata.json", `{"path":"${encodedPath}"}\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("metadata.json:1: prohibited internal path");
    });
  });

  it("fails closed for malformed ordinary JSON", () => {
    withRepository((root) => {
      writeFixture(root, "metadata.json", '{"broken":\n');

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("metadata.json: invalid JSON document");
    });
  });

  it("rejects prohibited sourcesContent in a base64 inline source map", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const privatePath = ["docs", "reviews", "launch.md"].join("/");
      const sourceMap = JSON.stringify({
        version: 3,
        sources: ["../src/index.ts"],
        sourcesContent: [`See ${privatePath}`],
        names: [],
        mappings: "",
      });
      const reference = `data:application/json;charset=utf-8;base64,${Buffer.from(sourceMap).toString("base64")}`;
      writeSourceMapReference(artifactRoot, "dist/index.js", reference);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js:1: prohibited internal path");
    });
  });

  it("rejects a personal source path in a percent-encoded inline source map", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const personalSource = ["", "home", "release-engineer", "sdk", "index.ts"].join("/");
      const sourceMap = JSON.stringify({
        version: 3,
        sources: [personalSource],
        names: [],
        mappings: "",
      });
      const reference = `data:application/json;charset=utf-8,${encodeURIComponent(sourceMap)}`;
      writeSourceMapReference(artifactRoot, "dist/index.js", reference);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js:1: prohibited personal absolute path");
    });
  });

  it.each(["base64", "percent-encoded"])("accepts a valid %s inline source map", (encoding) => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const sourceMap = JSON.stringify({
        version: 3,
        sources: ["../../src/index.ts"],
        names: [],
        mappings: "",
      });
      const reference =
        encoding === "base64"
          ? `data:application/json;charset=utf-8;base64,${Buffer.from(sourceMap).toString("base64")}`
          : `data:application/json;charset=utf-8,${encodeURIComponent(sourceMap)}`;
      writeSourceMapReference(artifactRoot, "dist/index.js", reference);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it.each([
    ["unsupported media type", "data:text/plain,%7B%7D", "unsupported inline source map data URL"],
    [
      "malformed base64",
      "data:application/json;base64,not-valid%%%",
      "malformed inline source map data URL",
    ],
  ])("rejects an %s inline source map", (_caseName, reference, diagnostic) => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeSourceMapReference(artifactRoot, "dist/index.js", reference);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`dist/index.js:1: ${diagnostic}`);
    });
  });

  it("rejects an oversized inline source map before decoding it", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const oversizedPayload = "A".repeat(12 * 1024 * 1024);
      writeSourceMapReference(
        artifactRoot,
        "dist/index.js",
        `data:application/json;base64,${oversizedPayload}`,
      );

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "dist/index.js:1: inline source map exceeds the 8388608-byte limit",
      );
    });
  });

  it("accepts a relative source map URL when the map exists", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeSourceMapReference(artifactRoot, "dist/index.js", "index.js.map");
      writeFixture(
        artifactRoot,
        "dist/index.js.map",
        JSON.stringify({ version: 3, sources: ["../src/index.ts"], names: [], mappings: "" }),
      );

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("rejects a missing relative source map URL", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeSourceMapReference(artifactRoot, "dist/index.js", "missing.js.map");

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js:1: missing source map");
      expect(result.stderr).not.toContain("dist/missing.js.map");
    });
  });

  it("rejects a missing CSS block source map URL", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeBlockSourceMapReference(artifactRoot, "dist/style.css", "style.css.map");

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/style.css:1: missing source map");
    });
  });

  it("fails closed for a malformed referenced external source map", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeSourceMapReference(artifactRoot, "dist/index.js", "index.js.map");
      writeFixture(artifactRoot, "dist/index.js.map", "{\n");

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js.map: invalid source map JSON");
    });
  });

  it("rejects a relative source map URL whose present target is ignored", () => {
    withRepository((root) => {
      writeFixture(root, ".gitignore", "dist/index.js.map\n");
      writeSourceMapReference(root, "dist/index.js", "index.js.map");
      writeFixture(
        root,
        "dist/index.js.map",
        JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
      );
      runGit(root, ["add", ".gitignore", "dist/index.js"]);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "dist/index.js:1: source map is outside the candidate surface",
      );
    });
  });

  it.each(["absolute path", "file URL"])("rejects a source map URL using an %s", (caseName) => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const absoluteMapPath = ["", "tmp", "private.map"].join("/");
      const reference = caseName === "file URL" ? `file://${absoluteMapPath}` : absoluteMapPath;
      writeSourceMapReference(artifactRoot, "dist/index.js", reference);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js:1: source map URL is an absolute local path");
    });
  });

  it("rejects a source map URL that escapes the artifact root", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeSourceMapReference(artifactRoot, "dist/index.js", "../../outside.map");

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist/index.js:1: source map URL escapes scan root");
    });
  });

  it("rejects Git metadata in a recursively scanned artifact", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      writeFixture(artifactRoot, ".git/config", "[core]\n\trepositoryformatversion = 0\n");

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(".git: prohibited Git metadata path");
    });
  });

  it("accepts public external Markdown links", () => {
    withRepository((root) => {
      writeFixture(
        root,
        "README.md",
        "Read the [public guide](https://example.com/guides/getting-started).\n",
      );

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("[public-surface] PASS");
    });
  });

  it.each([
    "https://example.com/Users/guide",
    "https://stackoverflow.com/users/12345/example",
  ])("accepts a public URL whose route resembles a user directory: %s", (url) => {
    withRepository((root) => {
      writeFixture(root, "README.md", `Read the [public guide](${url}).\n`);

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("accepts an ordinary relative source path containing a users directory", () => {
    withRepository((root) => {
      writeFixture(root, "src/users/model.ts", "export interface User {}\n");

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("ignores link-like syntax in fenced and inline Markdown code", () => {
    withRepository((root) => {
      writeFixture(
        root,
        "README.md",
        [
          "Plain text A](B) is not a link.",
          "",
          "```ts",
          "handlers[name](payload);",
          "```",
          "",
          "Inline `handlers[name](payload)` is code.",
          "",
        ].join("\n"),
      );

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it.each([
    ["inline code", (path: string) => `Local path: \`${path}/src/index.ts\`\n`],
    ["file URL", (path: string) => `Local path: file://${path}/src/index.ts\n`],
  ])("rejects a personal absolute path in %s", (_caseName, renderContents) => {
    withRepository((root) => {
      const personalPath = ["", "Users", "unlisted-maintainer"].join("/");
      writeFixture(root, "public.txt", renderContents(personalPath));

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.txt:1: prohibited personal absolute path");
    });
  });

  it.each([
    ["forward slashes", ["file://", "C:", "/Users/", "unlisted-maintainer/sdk"].join("")],
    ["backslashes", ["file://", "C:", "\\Users\\", "unlisted-maintainer\\sdk"].join("")],
  ])("rejects a Windows personal path using %s", (_caseName, personalPath) => {
    withRepository((root) => {
      writeFixture(root, "public.txt", `Local path: ${personalPath}\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.txt:1: prohibited personal absolute path");
    });
  });

  it.each([
    ["Unix", ["Path:", "", "Users", "unlisted-maintainer", "sdk"].join("/")],
    ["Windows", ["Path:C:", "Users", "unlisted-maintainer", "sdk"].join("\\")],
  ])("rejects a colon-labelled %s personal path", (_caseName, personalPath) => {
    withRepository((root) => {
      writeFixture(root, "public.txt", `${personalPath}\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.txt:1: prohibited personal absolute path");
    });
  });

  it.each(["vite", "rollup"])("rejects a personal path in a %s URL", (scheme) => {
    withRepository((root) => {
      const personalPath = ["", "Users", "unlisted-maintainer", "sdk"].join("/");
      writeFixture(root, "public.txt", `${scheme}://${personalPath}\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.txt:1: prohibited personal absolute path");
    });
  });

  it("rejects percent-encoded personal data in an HTTP query while allowing its pathname", () => {
    withRepository((root) => {
      const personalPath = ["", "Users", "unlisted-maintainer", "sdk"].join("/");
      const url = `https://example.com/Users/guide?source=${encodeURIComponent(personalPath)}`;
      writeFixture(root, "public.txt", `${url}\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.txt:1: prohibited personal absolute path");
      expect(result.stderr).not.toContain("source=");
    });
  });

  it.each([
    ["bracketed", (path: string) => `[${path}]\n`],
    ["HTML code", (path: string) => `<code>${path}</code>\n`],
  ])("rejects a %s plain personal path", (_caseName, render) => {
    withRepository((root) => {
      const personalPath = ["", "Users", "unlisted-maintainer", "private"].join("/");
      writeFixture(root, "public.txt", render(personalPath));

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public.txt:1: prohibited personal absolute path");
    });
  });

  it("scans ASCII policy signatures in otherwise opaque binary files", () => {
    withRepository((root) => {
      const privatePath = ["docs", "reviews", "private.html"].join("/");
      writeFileSync(
        join(root, "opaque.bin"),
        Buffer.concat([Buffer.from(privatePath, "ascii"), Buffer.from([0, 0xff])]),
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("opaque.bin:1: prohibited internal path");
    });
  });

  it.each([
    "notes.md",
    "index.js.map",
    "release.sh",
    "README",
    "Makefile",
    "Dockerfile",
    "CODEOWNERS",
    ".gitattributes",
    ".npmrc",
    "NOTICE",
    "AUTHORS",
    "CONTRIBUTORS",
    ".editorconfig",
    "Dockerfile.dev",
    "Makefile.in",
    "CODE_OF_CONDUCT",
    ".env.example",
  ])("fails closed for an undecodable textual artifact %s", (filename) => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      mkdirSync(join(artifactRoot, "dist"), { recursive: true });
      writeFileSync(join(artifactRoot, "dist", filename), Buffer.from([0xc3, 0x28]));

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`dist/${filename}: text file is not valid UTF-8`);
    });
  });

  it("fails closed for an undecodable executable shebang file", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const executable = join(artifactRoot, "bin", "release");
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(
        executable,
        Buffer.concat([Buffer.from("#!/bin/sh\n", "ascii"), Buffer.from([0xc3, 0x28])]),
      );
      chmodSync(executable, 0o755);

      const result = runScanner(root, ["--artifact-dir", artifactRoot]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("bin/release: text file is not valid UTF-8");
    });
  });

  it("accepts anchors and valid source-relative Markdown links", () => {
    withRepository((root) => {
      writeFixture(root, "README.md", "# Overview\n");
      writeFixture(
        root,
        "guides/start.md",
        "See [overview](../README.md#overview) or [details](#details).\n",
      );

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("allows only the scanner's marked policy-literal declarations", () => {
    withRepository((root) => {
      const internalPortingPath = ["docs", "porting"].join("/");
      const internalReviewsPath = ["docs", "reviews"].join("/");
      const personalPath = ["", "Users", "christian"].join("/");
      const siblingPath = ["core", "shared"].join("/");
      const planFilename = [
        "solwyn",
        "typescript",
        "public",
        "launch",
        "execution",
        "plan.md",
      ].join("-");
      const planningBaseline = ["Planning", "baseline:"].join(" ");
      const privateCommitMapping = ["private", "old-to-new", "commit", "mapping"].join(" ");
      writeFixture(
        root,
        "scripts/check-public-surface.mjs",
        [
          "const examples = [",
          `  "${internalPortingPath}", // public-surface-policy-literal`,
          `  "${internalReviewsPath}", // public-surface-policy-literal`,
          `  "${personalPath}", // public-surface-policy-literal`,
          `  "${siblingPath}", // public-surface-policy-literal`,
          `  "${["never", "computes", "cost"].join(" ")}", // public-surface-policy-literal`,
          `  "${["never", "sees", "your", "prompts"].join(" ")}", // public-surface-policy-literal`,
          `  "${["prompts", "never", "leave"].join(" ")}", // public-surface-policy-literal`,
          `  "${planFilename}", // public-surface-policy-literal`,
          `  "${planningBaseline}", // public-surface-policy-literal`,
          `  "${privateCommitMapping}", // public-surface-policy-literal`,
          "];",
          "",
        ].join("\n"),
      );

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("does not extend the scanner policy allowlist to another file", () => {
    withRepository((root) => {
      const privatePath = ["docs", "reviews"].join("/");
      writeFixture(root, "CONTRIBUTING.md", `"${privatePath}", // public-surface-policy-literal\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CONTRIBUTING.md:1: prohibited internal path");
    });
  });

  it("does not allow an unknown marked literal in the scanner", () => {
    withRepository((root) => {
      const unknownPersonalPath = ["", "Users", "unlisted-maintainer"].join("/");
      writeFixture(
        root,
        "scripts/check-public-surface.mjs",
        `"${unknownPersonalPath}", // public-surface-policy-literal\n`,
      );

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "scripts/check-public-surface.mjs:1: prohibited personal absolute path",
      );
    });
  });

  it.each([
    ["without its marker", ""],
    ["with extra marker text", " // public-surface-policy-literal extra"],
  ])("does not allow a known scanner literal %s", (_caseName, suffix) => {
    withRepository((root) => {
      const knownPrivatePath = ["docs", "reviews"].join("/");
      writeFixture(root, "scripts/check-public-surface.mjs", `"${knownPrivatePath}",${suffix}\n`);

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "scripts/check-public-surface.mjs:1: prohibited internal path",
      );
    });
  });

  it("excludes an intentionally deleted tracked file from the candidate surface", () => {
    withRepository((root) => {
      const deletedPath = ["docs", "reviews", "archived.md"].join("/");
      writeFixture(root, deletedPath, "private archive\n");
      runGit(root, ["add", deletedPath]);
      runGit(root, [
        "-c",
        "user.name=Public Surface Test",
        "-c",
        "user.email=public-surface@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]);
      unlinkSync(join(root, deletedPath));

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("rejects a staged index entry that differs from the current worktree", () => {
    withRepository((root) => {
      const gitIdentity = [
        "-c",
        "user.name=Public Surface Test",
        "-c",
        "user.email=public-surface@example.invalid",
      ];
      writeFixture(root, "guide.md", "base\n");
      runGit(root, ["add", "guide.md"]);
      runGit(root, [...gitIdentity, "commit", "--quiet", "-m", "base"]);
      writeFixture(root, "guide.md", "staged version\n");
      runGit(root, ["add", "guide.md"]);
      writeFixture(root, "guide.md", "current version\n");

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("guide.md: staged index entry differs from worktree");
      expect(result.stderr).not.toContain("staged version");
      expect(result.stderr).not.toContain("current version");
    });
  });

  it.each([
    ["assume-unchanged", "--assume-unchanged"],
    ["skip-worktree", "--skip-worktree"],
  ])("rejects an index entry marked %s", (_caseName, flag) => {
    withRepository((root) => {
      const gitIdentity = [
        "-c",
        "user.name=Public Surface Test",
        "-c",
        "user.email=public-surface@example.invalid",
      ];
      writeFixture(root, "guide.md", "base\n");
      runGit(root, ["add", "guide.md"]);
      runGit(root, [...gitIdentity, "commit", "--quiet", "-m", "base"]);
      const privatePath = ["docs", "reviews"].join("/");
      writeFixture(root, "guide.md", `staged ${privatePath}\n`);
      runGit(root, ["add", "guide.md"]);
      runGit(root, ["update-index", flag, "guide.md"]);
      writeFixture(root, "guide.md", "safe worktree copy\n");

      const result = runScanner(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("guide.md: prohibited Git index visibility flag");
      expect(result.stderr).not.toContain(privatePath);
    });
  });

  it("accepts a staged deletion that is also absent from the worktree", () => {
    withRepository((root) => {
      const gitIdentity = [
        "-c",
        "user.name=Public Surface Test",
        "-c",
        "user.email=public-surface@example.invalid",
      ];
      writeFixture(root, "obsolete.md", "obsolete\n");
      runGit(root, ["add", "obsolete.md"]);
      runGit(root, [...gitIdentity, "commit", "--quiet", "-m", "base"]);
      unlinkSync(join(root, "obsolete.md"));
      runGit(root, ["add", "--update", "obsolete.md"]);

      const result = runScanner(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("reports a missing Git executable distinctly from a non-repository", () => {
    withRepository((root) => {
      const result = runScanner(root, [], { ...process.env, PATH: "" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[public-surface] FAIL Git executable is unavailable");
      expect(result.stderr).not.toContain("not a Git work tree");
    });
  });

  it("redacts an artifact traversal error", () => {
    withRepository((root) => {
      const artifactRoot = join(root, "unpacked-package");
      const unreadableDirectory = join(artifactRoot, "private-directory-name");
      mkdirSync(unreadableDirectory, { recursive: true });
      chmodSync(unreadableDirectory, 0o000);

      let result: ScannerResult;
      try {
        result = runScanner(root, ["--artifact-dir", artifactRoot]);
      } finally {
        chmodSync(unreadableDirectory, 0o700);
      }

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[public-surface] FAIL unable to read artifact directory");
      expect(result.stderr).not.toContain("private-directory-name");
    });
  });
});
