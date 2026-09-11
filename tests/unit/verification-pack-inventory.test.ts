import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const verifier = fileURLToPath(
  new URL("../../scripts/verification/package-consumers.mjs", import.meta.url),
);
// Reviewed release payload, independent of whichever dist happens to exist in the checkout.
const reviewedFiles = [
  "package/LICENSE",
  "package/dist/anthropic-N2AUVBVR.cjs",
  "package/dist/bedrock-5UBXC72Z.cjs",
  "package/dist/chunk-22YDVSWG.cjs",
  "package/dist/chunk-2YIU7KDZ.cjs",
  "package/dist/chunk-4ZSAMWAY.cjs",
  "package/dist/chunk-6RNWEM3X.cjs",
  "package/dist/chunk-7SBCRY6W.cjs",
  "package/dist/chunk-D7GZL3WF.cjs",
  "package/dist/chunk-OJFYCU7X.cjs",
  "package/dist/chunk-QE7LGL2T.cjs",
  "package/dist/google-VHJR4W25.cjs",
  "package/dist/ai-sdk/index.cjs",
  "package/dist/index.cjs",
  "package/dist/testing/index.cjs",
  "package/dist/node.cjs",
  "package/dist/openai-2YXZNJYM.cjs",
  "package/dist/openai-compatible-WZAORKCV.cjs",
  "package/dist/together-KOX4IBNY.cjs",
  "package/dist/ai-sdk/index.d.cts",
  "package/dist/index.d.cts",
  "package/dist/testing/index.d.cts",
  "package/dist/node.d.cts",
  "package/dist/proxies-B0tJ1ewF.d.cts",
  "package/dist/types-DGWzXN2c.d.cts",
  "package/dist/anthropic-2OQ6V2RT.js",
  "package/dist/bedrock-CXHXWOC4.js",
  "package/dist/chunk-7OZBA6Z5.js",
  "package/dist/chunk-GAUVAODF.js",
  "package/dist/chunk-IXHIOICO.js",
  "package/dist/chunk-LJOFDSMO.js",
  "package/dist/chunk-OTNSLPD2.js",
  "package/dist/chunk-QBULH3NK.js",
  "package/dist/chunk-QWDIOEKR.js",
  "package/dist/chunk-UDIO23HU.js",
  "package/dist/google-F664LEYA.js",
  "package/dist/ai-sdk/index.js",
  "package/dist/index.js",
  "package/dist/testing/index.js",
  "package/dist/node.js",
  "package/dist/openai-compatible-LCSLOJ6M.js",
  "package/dist/openai-YYW6DHCR.js",
  "package/dist/together-WLP4LGCK.js",
  "package/package.json",
  "package/dist/anthropic-2OQ6V2RT.js.map",
  "package/dist/anthropic-N2AUVBVR.cjs.map",
  "package/dist/bedrock-5UBXC72Z.cjs.map",
  "package/dist/bedrock-CXHXWOC4.js.map",
  "package/dist/chunk-22YDVSWG.cjs.map",
  "package/dist/chunk-2YIU7KDZ.cjs.map",
  "package/dist/chunk-4ZSAMWAY.cjs.map",
  "package/dist/chunk-6RNWEM3X.cjs.map",
  "package/dist/chunk-7OZBA6Z5.js.map",
  "package/dist/chunk-7SBCRY6W.cjs.map",
  "package/dist/chunk-D7GZL3WF.cjs.map",
  "package/dist/chunk-GAUVAODF.js.map",
  "package/dist/chunk-IXHIOICO.js.map",
  "package/dist/chunk-LJOFDSMO.js.map",
  "package/dist/chunk-OJFYCU7X.cjs.map",
  "package/dist/chunk-OTNSLPD2.js.map",
  "package/dist/chunk-QBULH3NK.js.map",
  "package/dist/chunk-QE7LGL2T.cjs.map",
  "package/dist/chunk-QWDIOEKR.js.map",
  "package/dist/chunk-UDIO23HU.js.map",
  "package/dist/google-F664LEYA.js.map",
  "package/dist/google-VHJR4W25.cjs.map",
  "package/dist/ai-sdk/index.cjs.map",
  "package/dist/index.cjs.map",
  "package/dist/testing/index.cjs.map",
  "package/dist/ai-sdk/index.js.map",
  "package/dist/index.js.map",
  "package/dist/testing/index.js.map",
  "package/dist/node.cjs.map",
  "package/dist/node.js.map",
  "package/dist/openai-2YXZNJYM.cjs.map",
  "package/dist/openai-compatible-LCSLOJ6M.js.map",
  "package/dist/openai-compatible-WZAORKCV.cjs.map",
  "package/dist/openai-YYW6DHCR.js.map",
  "package/dist/together-KOX4IBNY.cjs.map",
  "package/dist/together-WLP4LGCK.js.map",
  "package/CHANGELOG.md",
  "package/README.md",
  "package/dist/ai-sdk/index.d.ts",
  "package/dist/index.d.ts",
  "package/dist/testing/index.d.ts",
  "package/dist/node.d.ts",
  "package/dist/proxies-CCfgkFz8.d.ts",
  "package/dist/types-DGWzXN2c.d.ts",
];

describe("reviewed package inventory", () => {
  it.each([
    "complete",
    "lf-listing",
    "crlf-listing",
    "new-content-hashes",
    "missing-license",
    "missing-sourcemap",
    "missing-provider",
    "unexpected-dist",
    "duplicate",
  ])("checks full publication membership: %s", (scenario) => {
    let files = [...reviewedFiles];
    if (scenario === "missing-license") files = files.filter((file) => file !== "package/LICENSE");
    if (scenario === "missing-sourcemap")
      files = files.filter((file) => file !== "package/dist/index.js.map");
    if (scenario === "missing-provider")
      files = files.filter((file) => file !== "package/dist/google-F664LEYA.js");
    if (scenario === "unexpected-dist") files.push("package/dist/orphan.js");
    if (scenario === "duplicate") files.push("package/LICENSE");
    if (scenario === "new-content-hashes")
      files = files.map((file) => file.replace("F664LEYA", "NEW12345"));
    const program =
      "import {assertPackageInventory} from " +
      JSON.stringify(verifier) +
      "; import fs from 'node:fs'; assertPackageInventory(JSON.parse(fs.readFileSync(0,'utf8')));";
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      input: JSON.stringify(
        scenario.endsWith("-listing")
          ? ["package/", ...files].join(scenario === "crlf-listing" ? "\r\n" : "\n")
          : files,
      ),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(
      ["complete", "new-content-hashes", "lf-listing", "crlf-listing"].includes(scenario) ? 0 : 1,
    );
    if (result.status !== 0)
      expect(result.stderr).toMatch(
        /inventory differs|Duplicate tarball entries|Missing matching sourcemap/,
      );
  });
});
