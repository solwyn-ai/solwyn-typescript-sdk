import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { collectUntil } from "../../probes/gc.mts";

const [root, format] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const nativeHooks = require("node:async_hooks");
const createHook = nativeHooks.createHook;
const enabled = new WeakMap();
nativeHooks.createHook = (callbacks) => {
  const hook = createHook(callbacks);
  const enable = hook.enable.bind(hook);
  const disable = hook.disable.bind(hook);
  hook.enable = () => {
    enabled.set(hook, true);
    return enable();
  };
  hook.disable = () => {
    enabled.set(hook, false);
    return disable();
  };
  return hook;
};
syncBuiltinESMExports();
const load = (entry, kind) =>
  kind === "esm"
    ? import(pathToFileURL(`${root}/dist/${entry}.js`).href)
    : require(`${root}/dist/${entry}.cjs`);
const first = await load("node", format);
const owners = globalThis[Symbol.for("@solwyn/sdk.node.runOwners.v2")];
assert.equal(enabled.get(owners.hook) ?? false, false);
const second = await load("node", format === "esm" ? "cjs" : "esm");
assert.equal(globalThis[Symbol.for("@solwyn/sdk.node.runOwners.v2")], owners);
assert.equal(enabled.get(owners.hook) ?? false, false);

const clients = [first, second].map(
  (sdk) =>
    new sdk.Solwyn(
      {
        chat: {
          completions: {
            create() {
              throw new Error("provider must not run");
            },
          },
        },
      },
      { apiKey: `sk_proj_${"a".repeat(64)}`, provider: "openai", reportUntrackedSurfaces: false },
    ),
);
assert.equal(first.coverage(clients[1]).provider, "openai");
assert.equal(second.coverage(clients[0]).provider, "openai");
await first.run("shared-formats", async () => {
  assert.equal(enabled.get(owners.hook) ?? false, true);
  const id = first.currentRun()?.agentRunId;
  await setImmediate();
  assert.equal(second.currentRun()?.agentRunId, id);
});
await collectUntil(
  () => owners.liveCount === 0 && !(enabled.get(owners.hook) ?? false),
  () =>
    `shared ${format} run owners=${owners.liveCount}, hookEnabled=${enabled.get(owners.hook) ?? false}`,
);
assert.equal(enabled.get(owners.hook) ?? false, false);
await Promise.all(clients.map((client) => client.close()));
process.stdout.write(`${JSON.stringify({ coverageShared: true, hookShared: true, idle: true })}\n`);
