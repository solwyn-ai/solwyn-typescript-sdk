/** Provider-free built-entry proof; the locked recipe consumer exercises the real framework. */
import assert from "node:assert/strict";

const [entry, nodeEntry, testingEntry] = process.argv.slice(2);
assert.ok(entry && nodeEntry && testingEntry);
const { SolwynAgents } = await import(entry);
class HttpModel {
  constructor(client) {
    this.client = client;
  }
  getResponse(request) {
    return this.client.chat.completions.create(request);
  }
  getStreamedResponse() {
    throw new Error("not used by this structural fixture");
  }
  getRetryAdvice() {
    return undefined;
  }
}
class HttpProvider {
  constructor({ openAIClient }) {
    this.client = openAIClient;
  }
  async getModel() {
    return new HttpModel(this.client);
  }
}
assert.throws(() => new SolwynAgents({ client: {}, OpenAIProvider: HttpProvider }), {
  name: "ConfigurationError",
});
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
const agents = new SolwynAgents({ client, OpenAIProvider: HttpProvider });
const hooks = new Map();
const runner = {
  config: { modelProvider: agents.modelProvider },
  on(event, callback) {
    hooks.set(event, callback);
  },
  async run(agent, _input) {
    hooks.get("agent_start")(undefined, agent);
    const model = await this.config.modelProvider.getModel();
    const result = await model.getResponse({ model: agent.model });
    hooks.get("agent_end")(undefined, agent);
    return result;
  },
};
await agents.run(runner, { name: "Worker", model: "synthetic" }, "Synthetic input.", {
  workflow: "dist-smoke",
  tags: { team: "support" },
});
await client.close();
assert.equal(dispatches, 1);
assert.equal(plane.checks.length, 1);
assert.equal(plane.confirms.length, 1);
assert.equal(plane.ingested.length, 1);
assert.equal(plane.ingested[0].agent_run_name, "agent:Worker");
assert.match(plane.ingested[0].parent_agent_run_id, /^run_/);
assert.equal(agents.invocations.size, 0);
process.stdout.write(
  JSON.stringify({ loaded: true, nodeRequired: true, dispatches: 1, checks: 1, ingested: 1 }) +
    "\n",
);
