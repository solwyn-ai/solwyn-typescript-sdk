import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ConfigurationError } from "../../src/errors";
import {
  BudgetEnforcer,
  type FetchLike,
  type resolveConfig,
  Solwyn,
  type SolwynConfigOptions,
} from "../../src/index";
import { MetadataReporter } from "../../src/reporter";

const API_KEY = `sk_proj_${"0".repeat(64)}`;

function expectInvalidFetch(construct: () => unknown): void {
  let thrown: unknown;
  try {
    construct();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ConfigurationError);
  expect(thrown).toMatchObject({ message: "fetch must be a function", field: "fetch" });
}

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

/** Repeatedly strip comments so comments containing comment-looking text cannot hide a read. */
function stripCommentsRecursively(source: string): string {
  let stripped = source;
  for (;;) {
    const next = stripped.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/gm, "$1 ");
    if (next === stripped) return next;
    stripped = next;
  }
}

describe("fetch construction seam", () => {
  it("exports the FetchLike type from the edge-safe root", () => {
    expectTypeOf<FetchLike>().toBeFunction();
  });

  it("keeps the root resolveConfig API limited to its original options argument", () => {
    expectTypeOf<Parameters<typeof resolveConfig>>().toEqualTypeOf<
      [options?: SolwynConfigOptions]
    >();
  });

  it("rejects a present non-function on BudgetEnforcer before transport use", () => {
    expectInvalidFetch(
      () =>
        new BudgetEnforcer({
          apiKey: API_KEY,
          apiUrl: "http://control-plane.invalid",
          fetch: 42 as unknown as FetchLike,
        }),
    );
  });

  it("rejects a present non-function on MetadataReporter before reporter work", () => {
    expectInvalidFetch(
      () =>
        new MetadataReporter("http://control-plane.invalid", API_KEY, {
          fetch: {} as FetchLike,
        }),
    );
  });

  it("rejects a present non-function on Solwyn before constructing internal components", () => {
    const provider = { chat: { completions: { create: () => ({}) } } };
    expectInvalidFetch(
      () => new Solwyn(provider, { apiKey: API_KEY, fetch: "nope" as unknown as FetchLike }),
    );
  });

  it("rejects every non-function shape at all three constructors", () => {
    const provider = { chat: { completions: { create: () => ({}) } } };
    for (const value of [null, false, {}, "fetch", 1]) {
      expectInvalidFetch(
        () =>
          new BudgetEnforcer({
            apiKey: API_KEY,
            apiUrl: "http://control-plane.invalid",
            fetch: value as unknown as FetchLike,
          }),
      );
      expectInvalidFetch(
        () =>
          new MetadataReporter("http://control-plane.invalid", API_KEY, {
            fetch: value as unknown as FetchLike,
          }),
      );
      expectInvalidFetch(
        () =>
          new Solwyn(provider, {
            apiKey: API_KEY,
            fetch: value as unknown as FetchLike,
          }),
      );
    }
  });

  it("accepts explicit undefined at all three constructors", async () => {
    const budget = new BudgetEnforcer({
      apiKey: API_KEY,
      apiUrl: "http://control-plane.invalid",
      fetch: undefined,
    });
    const reporter = new MetadataReporter("http://control-plane.invalid", API_KEY, {
      fetch: undefined,
    });
    const provider = { chat: { completions: { create: () => ({}) } } };
    const solwyn = new Solwyn(provider, { apiKey: API_KEY, fetch: undefined });
    await budget.close();
    await reporter.close();
    await solwyn.close();
  });

  it("keeps W1a double-wrap rejection ahead of fetch validation", async () => {
    const provider = { chat: { completions: { create: () => ({}) } } };
    const wrapped = new Solwyn(provider, { apiKey: API_KEY });
    let thrown: unknown;
    try {
      new Solwyn(wrapped, { apiKey: API_KEY, fetch: "nope" as unknown as FetchLike });
    } catch (error) {
      thrown = error;
    } finally {
      await wrapped.close();
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect(thrown).toMatchObject({
      message: "client is already wrapped by Solwyn — pass the raw provider client",
      field: "client",
    });
  });

  it("keeps unknown-option rejection ahead of fetch validation", () => {
    const provider = { chat: { completions: { create: () => ({}) } } };
    let thrown: unknown;
    try {
      new Solwyn(provider, {
        apiKey: API_KEY,
        fetch: "nope" as unknown as FetchLike,
        removedOption: true,
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect(thrown).toMatchObject({
      message: "unexpected option 'removedOption'",
      field: "removedOption",
    });
  });

  it("keeps the only executable global fetch read in transport.ts", () => {
    const root = join(process.cwd(), "src");
    const reads = listTypeScriptFiles(root).flatMap((path) => {
      const executable = stripCommentsRecursively(readFileSync(path, "utf8"));
      return [...executable.matchAll(/\bglobalThis\s*\.\s*fetch\b/g)].map(() =>
        relative(root, path).split(sep).join("/"),
      );
    });

    expect(reads).toEqual(["transport.ts"]);
  });
});
