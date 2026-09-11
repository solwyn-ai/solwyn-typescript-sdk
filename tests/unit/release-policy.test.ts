import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const policyPath = fileURLToPath(new URL("../../scripts/release-policy.mjs", import.meta.url));

interface ReleasePolicy {
  compareVersions(left: string, right: string): number;
  validatePublishableVersion(value: string): unknown;
  releaseChannel(version: string): "latest" | "next";
  validateReleasePolicy(input: { readonly candidate: string; readonly packument: unknown }): {
    readonly channel: "latest" | "next";
  };
}

async function loadPolicy(): Promise<ReleasePolicy> {
  expect(existsSync(policyPath), "release-policy.mjs must provide the reviewed pure policy").toBe(
    true,
  );
  return (await import(pathToFileURL(policyPath).href)) as ReleasePolicy;
}

describe("release channel policy", () => {
  it.each([
    ["1.2.3", "latest"],
    ["1.2.3-rc.1", "next"],
    ["2.0.0-beta.2", "next"],
  ] as const)("maps canonical version %s to %s", async (version, expected) => {
    const policy = await loadPolicy();

    expect(policy.releaseChannel(version)).toBe(expected);
  });

  it.each([
    "0.0.0",
    "01.2.3",
    "1.2.3-01",
    "1.2.3+build.1",
    "1.2.3-",
    "not-semver",
  ])("rejects noncanonical release version %s", async (version) => {
    const policy = await loadPolicy();

    expect(() => policy.releaseChannel(version)).toThrow(
      version === "0.0.0" ? /placeholder/i : /Noncanonical/,
    );
  });

  it.each([
    "0.0.1",
    "1.2.3",
    "1.2.3-0",
    "1.2.3-rc.1",
  ])("accepts publishable version %s through the canonical validator", async (version) => {
    const policy = await loadPolicy();

    expect(() => policy.validatePublishableVersion(version)).not.toThrow();
  });

  it("rejects the unreleased placeholder through the canonical validator", async () => {
    const policy = await loadPolicy();

    expect(() => policy.validatePublishableVersion("0.0.0")).toThrow(/placeholder/i);
  });

  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.0.0", "1.0.1", -1],
    ["1.0.0", "1.0.0-rc.9", 1],
    ["1.0.0-rc.10", "1.0.0-rc.2", 1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
  ] as const)("compares %s with %s", async (left, right, expected) => {
    const policy = await loadPolicy();

    expect(policy.compareVersions(left, right)).toBe(expected);
  });
});

describe("packument release policy", () => {
  it("rejects the unreleased placeholder before channel selection", async () => {
    const policy = await loadPolicy();

    expect(() =>
      policy.validateReleasePolicy({
        candidate: "0.0.0",
        packument: { name: "@solwyn/sdk", "dist-tags": {}, versions: {} },
      }),
    ).toThrow(/placeholder/i);
  });

  it.each([
    ["stable advance", "1.0.1", { latest: "1.0.0", next: "1.1.0-rc.1" }, "latest"],
    ["prerelease advance", "1.1.0-rc.2", { latest: "1.0.0", next: "1.1.0-rc.1" }, "next"],
    ["first stable", "1.0.0", { next: "1.0.0-rc.1" }, "latest"],
    ["first prerelease", "1.1.0-rc.1", { latest: "1.0.0" }, "next"],
  ] as const)("accepts %s", async (_name, candidate, distTags, channel) => {
    const policy = await loadPolicy();
    const versions = Object.fromEntries(Object.values(distTags).map((version) => [version, {}]));

    expect(
      policy.validateReleasePolicy({
        candidate,
        packument: { name: "@solwyn/sdk", "dist-tags": distTags, versions },
      }),
    ).toEqual({ channel });
  });

  it.each([
    ["stable equality", "1.0.0", { latest: "1.0.0" }, ["1.0.0"], /already exists/],
    ["stable rollback", "0.9.9", { latest: "1.0.0" }, ["1.0.0"], /latest/],
    [
      "next rollback",
      "1.1.0-alpha.1",
      { latest: "1.0.0", next: "1.1.0-rc.1" },
      ["1.0.0", "1.1.0-rc.1"],
      /next/,
    ],
    [
      "next below stable",
      "0.9.1-rc.1",
      { latest: "1.0.0", next: "0.9.0-rc.1" },
      ["1.0.0", "0.9.0-rc.1"],
      /latest/,
    ],
    ["version reuse", "1.1.0", { latest: "1.0.0" }, ["1.0.0", "1.1.0"], /already exists/],
    ["malformed tag", "1.1.0", { latest: "not-semver" }, ["not-semver"], /SemVer/],
    ["dangling tag", "1.1.0", { latest: "1.0.0" }, [], /unknown version/],
  ] as const)("rejects %s", async (_name, candidate, distTags, versionKeys, error) => {
    const policy = await loadPolicy();
    const versions = Object.fromEntries(versionKeys.map((version) => [version, {}]));

    expect(() =>
      policy.validateReleasePolicy({
        candidate,
        packument: { name: "@solwyn/sdk", "dist-tags": distTags, versions },
      }),
    ).toThrow(error);
  });

  it.each([
    [null, /packument/],
    [{ name: "attacker", versions: {}, "dist-tags": {} }, /package/],
    [{ name: "@solwyn/sdk", versions: [], "dist-tags": {} }, /versions/],
    [{ name: "@solwyn/sdk", versions: {}, "dist-tags": [] }, /dist-tags/],
  ] as const)("rejects malformed packument %#", async (packument, error) => {
    const policy = await loadPolicy();

    expect(() => policy.validateReleasePolicy({ candidate: "1.0.0", packument })).toThrow(error);
  });
});
