import assert from "node:assert/strict";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { currentRun, run } from "../../src/node";
import { getCurrentRun } from "../../src/run-context";
import { alive, collectUntil, settle } from "./gc.mjs";

function captureOwner(): WeakRef<object> {
  const owner = getCurrentRun()?.lifetime;
  assert.ok(owner);
  return new WeakRef(owner);
}

// This is the first user clone in this fresh process. Node 20 implements cloning
// with a cached internal MessageChannel, which must never own a customer run.
const completedOwners: WeakRef<object>[] = [];
for (let index = 0; index < 10; index++) {
  run("completed-clone", () => {
    completedOwners.push(captureOwner());
    assert.deepEqual(structuredClone({ count: index }), { count: index });
  });
}
await collectUntil(
  () => alive(completedOwners) === 0,
  () => `completed clone owners=${alive(completedOwners)}/${completedOwners.length}`,
);
assert.equal(
  completedOwners.filter((reference) => reference.deref() !== undefined).length,
  0,
  "the process-cached clone channel must not pin the first completed run",
);

// A real user-created channel remains capable of resuming inherited work after
// callback completion. It must keep its owner until both ports actually close.
let channel!: MessageChannel;
let channelOwner!: WeakRef<object>;
let expectedRunId: string | undefined;
let deliver!: (runId: string | undefined) => void;
const delivered = new Promise<string | undefined>((resolve) => {
  deliver = resolve;
});
run("user-message-channel", () => {
  channelOwner = captureOwner();
  expectedRunId = currentRun()?.agentRunId;
  channel = new MessageChannel();
  channel.port1.once("message", () => deliver(currentRun()?.agentRunId));
});
try {
  await settle(12);
  assert.ok(channelOwner.deref(), "open user MessagePorts retain run authority");
  channel.port2.postMessage(null);
  assert.equal(await delivered, expectedRunId, "the user message resumes its inherited run");
  await settle(12);
  assert.ok(channelOwner.deref(), "a live user channel stays owned after one delivered message");
} finally {
  const closed = Promise.all([once(channel.port1, "close"), once(channel.port2, "close")]);
  channel.port1.close();
  channel.port2.close();
  await closed;
}
await collectUntil(
  () => channelOwner.deref() === undefined,
  () => `closed MessageChannel owners=${Number(channelOwner.deref() !== undefined)}`,
);
assert.equal(channelOwner.deref(), undefined, "closed user MessagePorts release their owner");
process.stdout.write(
  `${JSON.stringify({ ok: true, completed_clones: 10, user_message_channel: true })}\n`,
);
