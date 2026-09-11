/** Real dual-entry process: global posture accounting, origin-local advisory reports. */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [esmEntry, cjsEntry] = process.argv.slice(2);
if (!esmEntry || !cjsEntry) throw new Error("surface harness requires ESM and CJS entry paths");
const esm = await import(pathToFileURL(esmEntry).href);
const cjs = createRequire(import.meta.url)(cjsEntry);
const warnings = [];
const reports = [[], []];
let meteringCalls = 0;
const logger = {
  debug() {},
  info() {},
  error() {},
  warn(...args) {
    warnings.push(args);
  },
};
const rawClients = [0, 1].map(() => ({
  chat: {
    completions: {
      create() {
        throw new Error("provider must not run");
      },
    },
  },
  futureShared() {},
}));
const clients = [esm, cjs].map(
  (sdk, index) =>
    new sdk.Solwyn(rawClients[index], {
      apiKey: `sk_proj_${"a".repeat(64)}`,
      provider: "openai",
      model: "gpt-4o-mini",
      onUnmetered: "warn",
      logger,
      fetch: async (url, init) => {
        if (new URL(url).pathname === "/api/v1/untracked-surfaces") {
          reports[index].push(...JSON.parse(String(init?.body)));
        } else {
          meteringCalls += 1;
        }
        return new Response(null, { status: 204 });
      },
    }),
);

clients[0].futureShared();
clients[1].futureShared();
const sharedWarnings = warnings.length;
const shared = globalThis[Symbol.for("@solwyn/sdk.surfacePosture.v1")];
const combinedCount =
  shared?.observations.get("openai", "openai_sdk", "futureShared")?.count ?? null;
for (let index = 0; index < 510; index += 1) {
  const origin = index % 2;
  const name = `future_${index}`;
  rawClients[origin][name] = () => {};
  Reflect.get(clients[origin], name);
}
rawClients[0].futureEsmOnly = () => {};
rawClients[1].futureCjsOnly = () => {};
Reflect.get(clients[0], "futureEsmOnly");
Reflect.get(clients[1], "futureCjsOnly");
rawClients[0].futureOverflow = () => {};
Reflect.get(clients[0], "futureOverflow");
await Promise.all(clients.map((client) => client.close()));

process.stdout.write(
  `${JSON.stringify({
    combinedCount,
    sharedWarnings,
    registrySize: shared?.observations.size ?? null,
    totalWarnings: warnings.length,
    retainedEsmOnly:
      shared?.observations.get("openai", "openai_sdk", "futureEsmOnly") !== undefined,
    retainedCjsOnly:
      shared?.observations.get("openai", "openai_sdk", "futureCjsOnly") !== undefined,
    esmSurfaces: reports[0].map((report) => report.surface),
    cjsSurfaces: reports[1].map((report) => report.surface),
    esmInstanceIds: [...new Set(reports[0].map((report) => report.sdk_instance_id))],
    cjsInstanceIds: [...new Set(reports[1].map((report) => report.sdk_instance_id))],
    meteringCalls,
  })}\n`,
);
