import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const verifier = fileURLToPath(
  new URL("../../scripts/verification/package-consumers.mjs", import.meta.url),
);
// Reviewed release payload, independent of whichever dist happens to exist in the checkout.
const reviewedFiles = [
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/README.md",
  "package/dist/ai-sdk/index.cjs",
  "package/dist/ai-sdk/index.cjs.map",
  "package/dist/ai-sdk/index.d.cts",
  "package/dist/ai-sdk/index.d.ts",
  "package/dist/ai-sdk/index.js",
  "package/dist/ai-sdk/index.js.map",
  "package/dist/anthropic-JZKZA7G2.cjs",
  "package/dist/anthropic-JZKZA7G2.cjs.map",
  "package/dist/anthropic-NORUIOH2.js",
  "package/dist/anthropic-NORUIOH2.js.map",
  "package/dist/bedrock-5D5BSHZX.js",
  "package/dist/bedrock-5D5BSHZX.js.map",
  "package/dist/bedrock-BBLNBJVX.cjs",
  "package/dist/bedrock-BBLNBJVX.cjs.map",
  "package/dist/chunk-3OB2KNEX.js",
  "package/dist/chunk-3OB2KNEX.js.map",
  "package/dist/chunk-4CPLO6TY.cjs",
  "package/dist/chunk-4CPLO6TY.cjs.map",
  "package/dist/chunk-5YSH4A4J.js",
  "package/dist/chunk-5YSH4A4J.js.map",
  "package/dist/chunk-6KKBZO4H.cjs",
  "package/dist/chunk-6KKBZO4H.cjs.map",
  "package/dist/chunk-6SC3RYZZ.cjs",
  "package/dist/chunk-6SC3RYZZ.cjs.map",
  "package/dist/chunk-75T3VUYQ.cjs",
  "package/dist/chunk-75T3VUYQ.cjs.map",
  "package/dist/chunk-7UORLNLN.cjs",
  "package/dist/chunk-7UORLNLN.cjs.map",
  "package/dist/chunk-ABGT6FKC.js",
  "package/dist/chunk-ABGT6FKC.js.map",
  "package/dist/chunk-DKLXZVPK.js",
  "package/dist/chunk-DKLXZVPK.js.map",
  "package/dist/chunk-DNSUDNRL.js",
  "package/dist/chunk-DNSUDNRL.js.map",
  "package/dist/chunk-F7RCFLW3.js",
  "package/dist/chunk-F7RCFLW3.js.map",
  "package/dist/chunk-FS3OF4EG.js",
  "package/dist/chunk-FS3OF4EG.js.map",
  "package/dist/chunk-KASALGTS.cjs",
  "package/dist/chunk-KASALGTS.cjs.map",
  "package/dist/chunk-LYSBNIM6.cjs",
  "package/dist/chunk-LYSBNIM6.cjs.map",
  "package/dist/chunk-OE5K7WDD.js",
  "package/dist/chunk-OE5K7WDD.js.map",
  "package/dist/chunk-OY2K5RN5.cjs",
  "package/dist/chunk-OY2K5RN5.cjs.map",
  "package/dist/chunk-PBHK7ROD.cjs",
  "package/dist/chunk-PBHK7ROD.cjs.map",
  "package/dist/chunk-QXN2II2N.js",
  "package/dist/chunk-QXN2II2N.js.map",
  "package/dist/chunk-QZVBE4UJ.cjs",
  "package/dist/chunk-QZVBE4UJ.cjs.map",
  "package/dist/chunk-SYGHOA4U.js",
  "package/dist/chunk-SYGHOA4U.js.map",
  "package/dist/chunk-WASI5WTJ.js",
  "package/dist/chunk-WASI5WTJ.js.map",
  "package/dist/chunk-YPVN6RU2.cjs",
  "package/dist/chunk-YPVN6RU2.cjs.map",
  "package/dist/google-COE3MG3I.cjs",
  "package/dist/google-COE3MG3I.cjs.map",
  "package/dist/google-T4SEHPWF.js",
  "package/dist/google-T4SEHPWF.js.map",
  "package/dist/index.cjs",
  "package/dist/index.cjs.map",
  "package/dist/index.d.cts",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/dist/index.js.map",
  "package/dist/langchain/index.cjs",
  "package/dist/langchain/index.cjs.map",
  "package/dist/langchain/index.d.cts",
  "package/dist/langchain/index.d.ts",
  "package/dist/langchain/index.js",
  "package/dist/langchain/index.js.map",
  "package/dist/node.cjs",
  "package/dist/node.cjs.map",
  "package/dist/node.d.cts",
  "package/dist/node.d.ts",
  "package/dist/node.js",
  "package/dist/node.js.map",
  "package/dist/openai-CBEDYNHR.cjs",
  "package/dist/openai-CBEDYNHR.cjs.map",
  "package/dist/openai-GYI4WIMK.js",
  "package/dist/openai-GYI4WIMK.js.map",
  "package/dist/openai-compatible-ECNV4FZT.cjs",
  "package/dist/openai-compatible-ECNV4FZT.cjs.map",
  "package/dist/openai-compatible-JKFHK2OS.js",
  "package/dist/openai-compatible-JKFHK2OS.js.map",
  "package/dist/proxies-Bq-4nH5m.d.cts",
  "package/dist/proxies-DGdIDmDd.d.ts",
  "package/dist/testing/index.cjs",
  "package/dist/testing/index.cjs.map",
  "package/dist/testing/index.d.cts",
  "package/dist/testing/index.d.ts",
  "package/dist/testing/index.js",
  "package/dist/testing/index.js.map",
  "package/dist/together-D2MXZ6L7.js",
  "package/dist/together-D2MXZ6L7.js.map",
  "package/dist/together-MBBC3QOF.cjs",
  "package/dist/together-MBBC3QOF.cjs.map",
  "package/dist/types-B9KLiW_Z.d.cts",
  "package/dist/types-B9KLiW_Z.d.ts",
  "package/package.json",
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
      files = files.filter((file) => file !== "package/dist/google-T4SEHPWF.js");
    if (scenario === "unexpected-dist") files.push("package/dist/orphan.js");
    if (scenario === "duplicate") files.push("package/LICENSE");
    if (scenario === "new-content-hashes")
      files = files.map((file) => file.replace("T4SEHPWF", "NEW12345"));
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
