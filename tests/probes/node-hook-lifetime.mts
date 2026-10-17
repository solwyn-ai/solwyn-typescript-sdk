import assert from "node:assert/strict";
import type { AsyncHook, HookCallbacks } from "node:async_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { collectUntil, settle } from "./gc.mjs";

const nativeHooks = createRequire(import.meta.url)(
  "node:async_hooks",
) as typeof import("node:async_hooks");
const createHook = nativeHooks.createHook;
const enabled = new WeakMap<AsyncHook, boolean>();
nativeHooks.createHook = (callbacks: HookCallbacks): AsyncHook => {
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
const { createRun, currentRun, run } = await import("../../src/node");

const owners = Reflect.get(globalThis, Symbol.for("@solwyn/sdk.node.runOwners.v2")) as {
  hook: AsyncHook;
  liveCount: number;
};
async function collectOwners(): Promise<void> {
  await collectUntil(
    () => owners.liveCount === 0 && !(enabled.get(owners.hook) ?? false),
    () => `run owners=${owners.liveCount}, hookEnabled=${enabled.get(owners.hook) ?? false}`,
  );
}

assert.equal(
  enabled.get(owners.hook) ?? false,
  false,
  "import alone must leave promise tracking disabled",
);
run("synchronous", () => assert.equal(enabled.get(owners.hook) ?? false, true));
await collectOwners();
assert.equal(
  enabled.get(owners.hook) ?? false,
  false,
  "completed runs must release promise tracking",
);

const handle = createRun("detached");
assert.equal(enabled.get(owners.hook) ?? false, true, "detached handles keep tracking available");
await settle(8);
assert.equal(enabled.get(owners.hook) ?? false, true, "unfinished handles retain their lifetime");
handle.finish();
await collectOwners();
assert.equal(
  enabled.get(owners.hook) ?? false,
  false,
  "a kept finished handle must not retain tracking",
);

let release!: () => void;
const blocker = new Promise<void>((resolve) => {
  release = resolve;
});
const seen: string[] = [];
const left = run("left", async () => {
  const id = currentRun()?.agentRunId;
  await blocker;
  assert.equal(currentRun()?.agentRunId, id);
  seen.push(id ?? "");
});
await run("right", async () => {
  const id = currentRun()?.agentRunId;
  await setImmediate();
  assert.equal(currentRun()?.agentRunId, id);
  seen.push(id ?? "");
});
await settle(8);
assert.equal(
  enabled.get(owners.hook) ?? false,
  true,
  "an unresolved run keeps the shared hook enabled",
);
release();
await left;
assert.equal(new Set(seen).size, 2, "concurrent runs stay isolated");
await collectOwners();
assert.equal(
  enabled.get(owners.hook) ?? false,
  false,
  "fulfilled retained promises must not retain tracking",
);
assert.equal(owners.liveCount, 0);
process.stdout.write(`${JSON.stringify({ idle: true, concurrent: true, detached: true })}\n`);
