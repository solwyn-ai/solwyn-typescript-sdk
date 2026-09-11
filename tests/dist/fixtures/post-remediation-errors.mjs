import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const first = process.argv[3];
const require = createRequire(path.join(root, "package.json"));
const load = (entry, format) =>
  format === "esm"
    ? import(pathToFileURL(path.join(root, "dist", `${entry}.js`)).href)
    : require(path.join(root, "dist", `${entry}.cjs`));
const formats = [first, first === "esm" ? "cjs" : "esm"];
const entries = [];
for (const format of formats) {
  for (const entry of ["index", "node"]) entries.push(await load(entry, format));
}
const makers = {
  SolwynError: (api) => new api.SolwynError("structural"),
  SurfaceInspectionError: (api) =>
    new api.SurfaceInspectionError({
      path: "future",
      stage: "static_inspection",
      causeType: "Error",
    }),
  BudgetExceededError: (api) =>
    new api.BudgetExceededError({
      projectId: null,
      budgetLimit: 1,
      currentUsage: 2,
      estimatedCost: 0,
      budgetPeriod: "daily",
      mode: "hard_deny",
    }),
  RunStoppedError: (api) =>
    new api.RunStoppedError({ agentRunId: "run_error_identity", reason: "stop", source: "server" }),
  ProviderUnavailableError: (api) =>
    new api.ProviderUnavailableError("unavailable", { attempted: ["openai"] }),
  ConfigurationError: (api) => new api.ConfigurationError("invalid", { field: "client" }),
  UnsupportedSurfaceError: (api) =>
    new api.UnsupportedSurfaceError({ surface: "embeddings", provider: "openai" }),
  UntrackedSpendSurfaceError: (api) =>
    new api.UntrackedSpendSurfaceError({
      surface: "future.create",
      token: null,
      provider: "openai",
      clientShape: "openai_sdk",
      kind: "unknown",
      capabilityScope: null,
      driftedFromRuleId: null,
    }),
  CoverageMismatchError: (api) =>
    new api.CoverageMismatchError({ differences: ["tracked: mismatch"] }),
  UntranslatableRequestError: (api) =>
    new api.UntranslatableRequestError({ source: "openai", target: "google", feature: "schema" }),
  UntranslatableModelError: (api) =>
    new api.UntranslatableModelError({ model: "model", provider: "google" }),
};
assert.deepEqual(
  Object.keys(entries[0])
    .filter((key) => /^[A-Z].*Error$/.test(key))
    .sort(),
  Object.keys(makers).sort(),
);
for (const producer of entries) {
  for (const [family, make] of Object.entries(makers)) {
    const error = make(producer);
    assert.equal(error.name, family);
    assert.equal(error instanceof Error, true);
    const serialized = JSON.stringify(error);
    const ownKeys = Reflect.ownKeys(error);
    for (const consumer of entries) {
      assert.equal(
        error instanceof consumer[family],
        true,
        `${family} crosses the format boundary`,
      );
      assert.equal(error instanceof consumer.SolwynError, true);
      assert.deepEqual(JSON.parse(JSON.stringify(make(consumer))), JSON.parse(serialized));
      assert.equal(error.toString(), make(consumer).toString());
      assert.deepEqual(Reflect.ownKeys(error), ownKeys);
      assert.equal({ ...error } instanceof consumer[family], false);
      assert.equal(
        { name: family, constructor: consumer[family] } instanceof consumer[family],
        false,
      );
      for (const other of Object.keys(makers)) {
        if (other !== family && other !== "SolwynError")
          assert.equal(error instanceof consumer[other], false);
      }
    }
    class CustomError extends producer[family] {}
    const custom = make({ ...producer, [family]: CustomError });
    for (const consumer of entries) {
      assert.equal(custom instanceof consumer.SolwynError, true);
      assert.equal(custom instanceof consumer[family], true);
      assert.equal(custom instanceof CustomError, true);
      assert.equal(make(consumer) instanceof CustomError, false);
    }
  }
  for (const consumer of entries) {
    for (const family of Object.keys(makers)) {
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("reflection failed");
          },
        },
      );
      assert.equal(hostile instanceof consumer[family], false);
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      assert.equal(revocable.proxy instanceof consumer[family], false);
    }
  }
  class CustomConfigurationError extends producer.ConfigurationError {}
  const custom = new CustomConfigurationError("custom");
  for (const consumer of entries) {
    assert.equal(custom instanceof consumer.SolwynError, true);
    assert.equal(custom instanceof consumer.ConfigurationError, true);
    assert.equal(custom instanceof CustomConfigurationError, true);
    assert.equal(
      new consumer.ConfigurationError("plain") instanceof CustomConfigurationError,
      false,
    );
  }
}
// Construction identity must never confer the translation package's private safe-label provenance.
for (const producer of entries) {
  const foreign = entries.find(
    (entry) => entry.UntranslatableRequestError !== producer.UntranslatableRequestError,
  );
  const { FakeControlPlane } = await load("testing/index", first);
  const plane = new FakeControlPlane();
  const marker = crypto.randomUUID();
  class ForeignTranslationError extends foreign.UntranslatableRequestError {}
  const injected = new ForeignTranslationError({ source: marker, target: marker, feature: marker });
  Object.assign(injected, { cause: { [marker]: marker }, toJSON: () => marker });
  const primary = {
    chat: {
      completions: {
        async create() {
          throw Object.assign(new Error("unavailable"), { status: 429 });
        },
      },
    },
  };
  const fallback = {
    messages: {
      async create() {
        return {
          usage: { input_tokens: 2, output_tokens: 3 },
          content: [
            {
              get type() {
                throw injected;
              },
            },
          ],
        };
      },
    },
  };
  const client = new producer.Solwyn(primary, {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    fallback: [[fallback, "claude-test"]],
    leaseEnabled: false,
    logger: producer.noopLogger,
    reportUntrackedSurfaces: false,
  });
  let caught;
  try {
    await client.chat.completions.create({ model: "gpt-test", messages: [], max_tokens: 5 });
  } catch (error) {
    caught = error;
  }
  assert.equal(
    caught instanceof foreign.UntranslatableRequestError,
    true,
    Object.keys(makers).find(
      (family) => family !== "SolwynError" && caught instanceof producer[family],
    ) ?? "NonSDKError",
  );
  assert.equal(caught !== injected, true);
  assert.equal(caught.feature === "malformed_request", true);
  assert.equal(JSON.stringify(caught).includes(marker), false);
  assert.equal(String(caught).includes(marker), false);
  assert.equal(caught.cause === undefined, true);
  await client.close();
}
let denied = 0;
let stopped = 0;
let dispatches = 0;
for (const [index, producer] of entries.entries()) {
  for (const testFormat of formats) {
    const { FakeControlPlane } = await load("testing/index", testFormat);
    const node = await load("node", testFormat);
    const plane = new FakeControlPlane();
    const client = new producer.Solwyn(
      {
        chat: {
          completions: {
            create() {
              dispatches++;
              return {};
            },
          },
        },
      },
      {
        apiKey: plane.apiKey,
        apiUrl: plane.apiUrl,
        fetch: plane.fetch,
        leaseEnabled: false,
        budgetCheckCacheTtl: 0,
        reportUntrackedSurfaces: false,
        logger: producer.noopLogger,
      },
    );
    const requireFamily = (family) => (error) => {
      for (const consumer of entries) {
        assert.equal(error instanceof consumer[family], true);
        assert.equal(error instanceof consumer.SolwynError, true);
      }
      return true;
    };
    await node.run(`denied-${index}-${testFormat}`, async () => {
      plane.denyRun(node.currentRun().agentRunId);
      await assert.rejects(
        client.chat.completions.create({ model: "gpt-test", messages: [] }),
        requireFamily("BudgetExceededError"),
      );
      denied++;
    });
    await node.run(`stopped-${index}-${testFormat}`, async () => {
      plane.stopRun(node.currentRun().agentRunId);
      await assert.rejects(
        client.chat.completions.create({ model: "gpt-test", messages: [] }),
        requireFamily("RunStoppedError"),
      );
      stopped++;
    });
    await client.close();
  }
}
let middlewareDenied = 0;
for (const format of formats) {
  const { createSolwynMiddleware } = await load("ai-sdk/index", format);
  const node = await load("node", format === "esm" ? "cjs" : "esm");
  const { FakeControlPlane } = await load("testing/index", format);
  const plane = new FakeControlPlane();
  const handle = createSolwynMiddleware({
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    leaseEnabled: false,
    logger: entries[0].noopLogger,
  });
  await node.run(`middleware-${format}`, async () => {
    plane.denyRun(node.currentRun().agentRunId);
    await assert.rejects(
      handle.middleware.wrapGenerate({
        model: { provider: "openai", modelId: "gpt-test" },
        params: { prompt: [] },
        doGenerate: async () => {
          dispatches++;
          return {};
        },
      }),
      (error) => {
        for (const consumer of entries) {
          assert.equal(error instanceof consumer.BudgetExceededError, true);
          assert.equal(error instanceof consumer.SolwynError, true);
        }
        return true;
      },
    );
    middlewareDenied++;
  });
  await handle.close();
}
assert.equal(dispatches, 0);
process.stdout.write(
  JSON.stringify({ families: Object.keys(makers).length, denied, stopped, middlewareDenied }),
);
