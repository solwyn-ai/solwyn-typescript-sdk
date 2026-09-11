import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const firstFormat = process.argv[3];
const require = createRequire(path.join(root, "package.json"));
const load = (entry, format) =>
  format === "esm"
    ? import(pathToFileURL(path.join(root, "dist", `${entry}.js`)).href)
    : require(path.join(root, "dist", `${entry}.cjs`));
const first = await load("node", firstFormat);
const second = await load("node", firstFormat === "esm" ? "cjs" : "esm");
const { FakeControlPlane } = await load("testing/index", "esm");
const plane = new FakeControlPlane();
let dispatches = 0;
const raw = {
  chat: {
    completions: {
      create() {
        dispatches++;
        return { usage: { prompt_tokens: 2, completion_tokens: 3 } };
      },
    },
  },
};
const options = {
  apiKey: plane.apiKey,
  apiUrl: plane.apiUrl,
  fetch: plane.fetch,
  leaseEnabled: false,
  budgetCheckCacheTtl: 0,
  reportUntrackedSurfaces: false,
  logger: first.noopLogger,
};
const client = new second.Solwyn(raw, options);
let denied = 0;
for (const [owner, reader] of [
  [first, second],
  [second, first],
]) {
  await owner.run("parent", { tags: { tenant: "shared" } }, async () => {
    await Promise.resolve();
    const parent = owner.currentRunContext();
    assert.deepEqual(reader.currentRunContext(), parent);
    await reader.run("child", async () => {
      const child = owner.currentRunContext();
      assert.equal(child.parentAgentRunId, parent.agentRunId);
      assert.deepEqual(child.tags, parent.tags);
      plane.denyRun(child.agentRunId);
      await assert.rejects(client.chat.completions.create({ model: "gpt-review", messages: [] }), {
        name: "BudgetExceededError",
      });
      denied++;
    });
    const handle = reader.createRun("detached");
    for (let activation = 0; activation < 2; activation++)
      await handle.activate(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(owner.currentRun()?.agentRunId, handle.runId);
        assert.equal(owner.currentRunContext().parentAgentRunId, parent.agentRunId);
        plane.denyRun(handle.runId);
        await assert.rejects(
          client.chat.completions.create({ model: "gpt-review", messages: [] }),
          { name: "BudgetExceededError" },
        );
        denied++;
      });
    handle.finish();
  });
}
await client.close();
assert.equal(dispatches, 0);
assert.equal(plane.checks.length, denied);
assert.equal(plane.ingested.length, denied);
for (const check of plane.checks) {
  assert.ok(check.agent_run_id);
  assert.deepEqual(check.tags, { tenant: "shared" });
}
for (const event of plane.ingested) {
  assert.ok(event.agent_run_id);
  assert.ok(event.parent_agent_run_id);
  assert.deepEqual(event.tags, { tenant: "shared" });
}
for (const [owner, other] of [
  [first, second],
  [second, first],
]) {
  const wrapper = new owner.Solwyn(raw, options);
  assert.equal(wrapper instanceof owner.Solwyn, true);
  assert.equal(wrapper instanceof other.Solwyn, true);
  assert.throws(() => new other.Solwyn(wrapper, options), {
    name: "ConfigurationError",
    field: "client",
  });
  assert.throws(() => new other.Solwyn(raw, { ...options, fallback: [[wrapper, "gpt-review"]] }), {
    name: "ConfigurationError",
    field: "client",
  });
  await wrapper.close();
}
assert.equal(dispatches, 0);
assert.equal(plane.confirms.length, 0);
process.stdout.write(
  `${JSON.stringify({
    firstFormat,
    denied,
    dispatches,
    checks: plane.checks.length,
    ingested: plane.ingested.length,
    sharedBrands: true,
  })}\n`,
);
