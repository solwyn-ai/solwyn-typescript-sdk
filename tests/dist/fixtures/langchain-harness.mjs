/** Plain Node proof of built integration loading, Node seam sharing, and metered attribution. */
import assert from "node:assert/strict";

const [entry, nodeEntry, testingEntry] = process.argv.slice(2);
assert.ok(entry && nodeEntry && testingEntry);
const { SolwynRunScopeHandler } = await import(entry);
assert.throws(() => new SolwynRunScopeHandler(), { name: "ConfigurationError" });
const { Solwyn } = await import(nodeEntry);
const { FakeControlPlane } = await import(testingEntry);
const plane = new FakeControlPlane();
let dispatches = 0;
const provider = {
  chat: {
    completions: {
      create() {
        dispatches++;
        return { usage: { prompt_tokens: 11, completion_tokens: 7 } };
      },
    },
  },
};
const client = new Solwyn(provider, {
  apiKey: plane.apiKey,
  apiUrl: plane.apiUrl,
  fetch: plane.fetch,
  leaseEnabled: false,
});
const handler = new SolwynRunScopeHandler();
handler.handleChainStart(
  undefined,
  undefined,
  "root",
  undefined,
  undefined,
  undefined,
  undefined,
  "dist-smoke",
);
handler.handleChatModelStart(undefined, undefined, "model", "root");
const options = handler.bindModelCall({}, { runId: "model", handlers: [handler] });
await handler.chatCompletionsLeaf(client).chat.completions.create({ model: "synthetic" }, options);
handler.handleLLMEnd(undefined, "model");
handler.handleChainEnd(undefined, "root");
await client.close();
assert.equal(dispatches, 1);
assert.equal(plane.checks.length, 1);
assert.equal(plane.ingested.length, 1);
assert.equal(plane.ingested[0].agent_run_name, "langchain:dist-smoke");
process.stdout.write(
  JSON.stringify({ loaded: true, nodeRequired: true, dispatches: 1, checks: 1, ingested: 1 }) +
    "\n",
);
