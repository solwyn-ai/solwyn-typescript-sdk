import assert from "node:assert/strict";
import type { AsyncHook, HookCallbacks } from "node:async_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";

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

const owners = Reflect.get(globalThis, Symbol.for("@solwyn/sdk.node.runOwners")) as {
  hook: AsyncHook;
  liveCount: number;
};
const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");

async function collect(): Promise<void> {
  for (let i = 0; i < 30 && owners.liveCount > 0; i++) {
    await setImmediate();
    forceGc?.();
  }
  await setImmediate();
}

assert.equal(
  enabled.get(owners.hook) ?? false,
  false,
  "import alone must leave promise tracking disabled",
);
run("synchronous", () => assert.equal(enabled.get(owners.hook) ?? false, true));
await collect();
assert.equal(
  enabled.get(owners.hook) ?? false,
  false,
  "completed runs must release promise tracking",
);

const handle = createRun("detached");
assert.equal(enabled.get(owners.hook) ?? false, true, "detached handles keep tracking available");
await collect();
assert.equal(enabled.get(owners.hook) ?? false, true, "unfinished handles retain their lifetime");
handle.finish();
await collect();
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
await collect();
assert.equal(
  enabled.get(owners.hook) ?? false,
  true,
  "an unresolved run keeps the shared hook enabled",
);
release();
await left;
assert.equal(new Set(seen).size, 2, "concurrent runs stay isolated");
await collect();
assert.equal(
  enabled.get(owners.hook) ?? false,
  false,
  "fulfilled retained promises must not retain tracking",
);
assert.equal(owners.liveCount, 0);
process.stdout.write(`${JSON.stringify({ idle: true, concurrent: true, detached: true })}\n`);
