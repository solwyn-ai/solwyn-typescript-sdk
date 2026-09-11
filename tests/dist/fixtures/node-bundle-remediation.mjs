import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.argv[2];
const require = createRequire(path.join(root, "package.json"));
const { build } = createRequire(require.resolve("tsup"))("esbuild");
const temporary = mkdtempSync(path.join(tmpdir(), "solwyn-node-bundle-"));
try {
  const installed = path.join(temporary, "node_modules/@solwyn/sdk");
  mkdirSync(installed, { recursive: true });
  cpSync(path.join(root, "dist"), path.join(installed, "dist"), { recursive: true });
  cpSync(path.join(root, "package.json"), path.join(installed, "package.json"));
  const zodRoot = path.dirname(require.resolve("zod/package.json"));
  symlinkSync(zodRoot, path.join(temporary, "node_modules/zod"), "dir");
  const results = [];
  for (const format of ["esm", "cjs"])
    for (const mode of ["bare", "named", "close"]) {
      const named = mode === "named";
      const imports =
        format === "esm"
          ? `${named ? 'import { Solwyn, noopLogger, run } from "@solwyn/sdk/node";' : 'import "@solwyn/sdk/node"; import { Solwyn, noopLogger } from "@solwyn/sdk";'} import { FakeControlPlane } from "@solwyn/sdk/testing";`
          : `${named ? 'const { Solwyn, noopLogger, run } = require("@solwyn/sdk/node");' : 'require("@solwyn/sdk/node"); const { Solwyn, noopLogger } = require("@solwyn/sdk");'} const { FakeControlPlane } = require("@solwyn/sdk/testing");`;
      const contents = `${imports}
(async () => {
  const plane = new FakeControlPlane();
  let dispatched = 0;
  const raw = { chat: { completions: { create() { dispatched++; return { usage: { prompt_tokens: 2, completion_tokens: 3 } }; } } } };
  const client = new Solwyn(raw, { apiKey: plane.apiKey, apiUrl: plane.apiUrl, fetch: plane.fetch, leaseEnabled: false, reportUntrackedSurfaces: false, reporterFlushInterval: 60, logger: noopLogger });
  globalThis.retainedClient = client;
  await ${named ? 'run("bundle", () => client.chat.completions.create({ model: "gpt-review", messages: [] }))' : 'client.chat.completions.create({ model: "gpt-review", messages: [] })'};
  ${mode === "close" ? "await client.close();" : ""}
  process.once("exit", () => process.stdout.write(JSON.stringify({ dispatched, confirms: plane.confirms.length, ingested: plane.ingested.length, installed: typeof Reflect.get(globalThis, Symbol.for("@solwyn/sdk/node-reporter-registration")) }) + "\\n"));
})();`;
      const output = await build({
        stdin: {
          contents,
          resolveDir: temporary,
          sourcefile: `consumer.${format === "esm" ? "mjs" : "cjs"}`,
        },
        bundle: true,
        platform: "node",
        format,
        target: "node20",
        write: false,
        treeShaking: true,
        metafile: true,
        logLevel: "silent",
      });
      assert.equal(
        output.warnings.some((warning) => warning.id === "ignored-bare-import"),
        false,
      );
      const extension = format === "esm" ? "mjs" : "cjs";
      const bundledFile = path.join(temporary, `${format}-${mode}.${extension}`);
      writeFileSync(bundledFile, output.outputFiles[0].text);
      const result = JSON.parse(
        execFileSync(process.execPath, [bundledFile], { encoding: "utf8", timeout: 20_000 }),
      );
      assert.deepEqual(result, { dispatched: 1, confirms: 1, ingested: 1, installed: "function" });
      assert.ok(
        Object.keys(output.metafile.inputs).some((file) =>
          file.endsWith(format === "esm" ? "dist/node.js" : "dist/node.cjs"),
        ),
      );
      results.push({ format, mode, ...result });
    }
  process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
