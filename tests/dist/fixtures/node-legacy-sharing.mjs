import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [root, format, order] = process.argv.slice(2);
const require = createRequire(import.meta.url);

// The registry shape and always-enabled hook used by the earlier Node entry.
function legacyNode() {
  const storeKey = Symbol.for("@solwyn/sdk.node.runStore");
  const ownersKey = Symbol.for("@solwyn/sdk.node.runOwners");
  globalThis[storeKey] ??= new AsyncLocalStorage();
  const store = globalThis[storeKey];
  if (globalThis[ownersKey] === undefined) {
    const resources = new Map();
    const synchronous = new Set();
    const hook = createHook({
      init(asyncId) {
        const owner = store.getStore()?.lifetimeRef.deref();
        if (owner !== undefined) resources.set(asyncId, owner);
      },
      promiseResolve(asyncId) {
        resources.delete(asyncId);
      },
      destroy(asyncId) {
        resources.delete(asyncId);
      },
    }).enable();
    globalThis[ownersKey] = { resources, synchronous, hook };
  }
  const owners = globalThis[ownersKey];
  return {
    owners,
    currentRun: () => store.getStore(),
    run(fn) {
      const owner = {};
      const frame = {
        agentRunId: `run_${crypto.randomUUID()}`,
        agentRunName: "legacy-run",
        lifetimeRef: new WeakRef(owner),
        tags: null,
        parentAgentRunId: null,
        parent: null,
      };
      owners.synchronous.add(owner);
      try {
        return store.run(frame, fn);
      } finally {
        owners.synchronous.delete(owner);
      }
    },
  };
}

let legacy;
if (order === "legacy-first") legacy = legacyNode();
const current =
  format === "esm"
    ? await import(pathToFileURL(`${root}/dist/node.js`).href)
    : require(`${root}/dist/node.cjs`);
legacy ??= legacyNode();

await legacy.run(async () => {
  const id = legacy.currentRun()?.agentRunId;
  await setImmediate();
  assert.equal(current.currentRun()?.agentRunId, id);
  assert.ok(legacy.owners.resources.size > 0, "legacy async resources must keep their run owner");
});
await current.run("current-run", async () => {
  const id = current.currentRun()?.agentRunId;
  await setImmediate();
  assert.equal(legacy.currentRun()?.agentRunId, id);
});
const detached = current.createRun("current-detached");
await detached.activate(async () => {
  await setImmediate();
  assert.equal(legacy.currentRun()?.agentRunId, detached.runId);
});
detached.finish();
legacy.owners.hook.disable();
process.stdout.write(`${JSON.stringify({ compatible: true })}\n`);
