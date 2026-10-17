import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDelivery,
  at,
  captureControlPlane,
  consume,
  INPUT_TOKENS,
  metadata,
  OUTPUT_TOKENS,
  providerFixture,
  until,
} from "./live-support.mjs";

const apiUrl = process.env.SOLWYN_LIVE_API_URL;
const apiKey = process.env.SOLWYN_LIVE_API_KEY;
const jwt = process.env.SOLWYN_LIVE_JWT;
const configured = Boolean(apiUrl && apiKey);

test("a Solwyn control plane with fake providers", {
  skip: !configured,
  timeout: 180_000,
}, async (t) => {
  const sdk = await import("../../dist/node.js");
  const probes = await import("../../dist/testing/index.js");
  const options = { apiUrl, apiKey };
  const probeFetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const projectCheck = await request("POST", "/budgets/check", {
    estimated_input_tokens: 1,
    model: "gpt-4.1",
    provider: "openai",
  });
  const projectId = projectCheck.project_id;
  assert.equal(typeof projectId, "string");
  // Release the discovery hold; it must not obscure counter/ledger reconciliation.
  if (projectCheck.reservation_id) {
    await request(
      "POST",
      "/budgets/confirm",
      {
        reservation_id: projectCheck.reservation_id,
        call_id: crypto.randomUUID(),
        model: "gpt-4.1",
        provider: "openai",
        token_details: sdk.createTokenDetails({ input_tokens: 0, output_tokens: 0 }),
      },
      204,
    );
  }

  async function request(method, path, body, status = 200, token = apiKey) {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, status, `${method} ${path} returned HTTP ${response.status}`);
    return status === 204 ? null : response.json();
  }

  function wrap(fixture, wire, provider, extra = {}) {
    return new sdk.Solwyn(fixture.raw, {
      ...options,
      provider,
      model: fixture.model,
      fetch: wire.fetch,
      logger,
      tags: {},
      failOpen: false,
      budgetCheckCacheTtl: 0,
      budgetCheckTimeout: 10,
      reporterFlushInterval: 0.1,
      reporterShutdownDeadline: 15,
      velocityMode: "off",
      ...extra,
    });
  }

  const projectPath = `/projects/${projectId}`;
  const budget = () => request("GET", `${projectPath}/budget`);
  const totals = () => request("GET", `${projectPath}/costs/total?range=7d`);

  async function runRow(runId, name) {
    const result = await request(
      "GET",
      `${projectPath}/agent-runs?range=7d&q=${encodeURIComponent(name)}`,
    );
    const rows = result.runs.filter((row) => row.name === name);
    assert.ok(rows.length <= 1, "the synthetic run name was not unique");
    if (rows.length === 0) return null;
    const events = await request(
      "GET",
      `${projectPath}/costs/events?range=7d&limit=100&agent_run=${encodeURIComponent(runId)}`,
    );
    return { row: rows[0], events: events.items };
  }

  async function assertRollup(runId, name, expectedEvents) {
    const result = await until(
      () => runRow(runId, name),
      (value) => value?.events.length === expectedEvents.length,
    );
    const identity = (event) =>
      JSON.stringify([
        event.provider,
        event.model,
        event.status,
        event.input_tokens,
        event.output_tokens,
      ]);
    assert.deepEqual(result.events.map(identity).sort(), expectedEvents.map(identity).sort());
    assert.ok(result.events.every((event) => event.agent_run_id === result.row.id));
    assert.equal(result.row.total_calls, expectedEvents.length);
    assert.equal(
      result.row.total_input_tokens,
      expectedEvents.reduce((sum, event) => sum + event.input_tokens, 0),
    );
    assert.equal(
      result.row.total_output_tokens,
      expectedEvents.reduce((sum, event) => sum + event.output_tokens, 0),
    );
    assert.ok(
      Math.abs(result.row.total_cost - result.events.reduce((sum, event) => sum + event.cost, 0)) <
        0.000001,
    );
    return result.row.total_cost;
  }

  async function exerciseProvider(provider, plane) {
    const wire = captureControlPlane(plane?.apiUrl ?? apiUrl, plane?.fetch);
    const fixture = providerFixture(provider, { onClose: () => assert.equal(wire.pending, 0) });
    const client = plane
      ? new sdk.Solwyn(fixture.raw, {
          ...options,
          apiUrl: plane.apiUrl,
          apiKey: plane.apiKey,
          fetch: wire.fetch,
          provider,
          logger,
          tags: {},
          budgetCheckCacheTtl: 0,
        })
      : wrap(fixture, wire, provider);
    const name = `sdk-live-${provider}-${crypto.randomUUID()}`;
    let runId;
    try {
      await sdk.run(name, { tags: { test_suite: "sdk_live" } }, async () => {
        runId = sdk.currentRun().agentRunId;
        await fixture.invoke(client);
        await consume(await fixture.invoke(client, true));
      });
    } finally {
      await client.close();
    }
    assertDelivery(wire);
    assert.equal(fixture.calls, 2);
    assert.equal(fixture.ended, 1);
    assert.equal(fixture.closed, true);
    assert.equal(at(wire, "/budgets/check").length, 2);
    assert.equal(at(wire, "/budgets/confirm").length, 2);
    assert.equal(at(wire, "/budgets/lease").length, 0, "tagged calls must not lease");
    assert.ok(at(wire, "/breaker-reports").length > 0);
    const events = metadata(wire);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.provider, provider);
      assert.equal(event.input_tokens, INPUT_TOKENS);
      assert.equal(event.output_tokens, OUTPUT_TOKENS);
      assert.equal(event.status, "success");
      assert.equal(event.token_details.is_estimated ?? false, false);
      assert.equal(event.lease_id, undefined);
    }
    return { wire, events, runId, name };
  }

  await t.test(
    "four providers: buffered, streamed, settled, drained, and reconciled with dashboard reads",
    async () => {
      const before = await totals();
      const beforeBudget = await budget();
      let runCost = 0;
      for (const provider of ["openai", "anthropic", "google", "bedrock"]) {
        const real = await exerciseProvider(provider);
        runCost += await assertRollup(real.runId, real.name, real.events);
        const fake = await exerciseProvider(provider, new probes.FakeControlPlane());
        const normalized = (events) =>
          events.map(
            ({ provider: name, model, input_tokens, output_tokens, status, token_details }) => ({
              provider: name,
              model,
              input_tokens,
              output_tokens,
              status,
              is_estimated: token_details.is_estimated ?? false,
            }),
          );
        assert.deepEqual(normalized(fake.events), normalized(real.events));
      }
      const after = await totals();
      const afterBudget = await budget();
      assert.equal(after.call_count - before.call_count, 8);
      assert.equal(after.total_input_tokens - before.total_input_tokens, 8 * INPUT_TOKENS);
      assert.equal(after.total_output_tokens - before.total_output_tokens, 8 * OUTPUT_TOKENS);
      assert.ok(Math.abs(after.total_cost - before.total_cost - runCost) < 0.000001);
      assert.ok(
        Math.abs(afterBudget.current_usage - beforeBudget.current_usage - runCost) < 0.000002,
      );
    },
  );

  await t.test(
    "mid-stream provider errors settle per-call usage and preserve lease behavior",
    async () => {
      const before = await totals();
      const beforeBudget = await budget();
      let runCost = 0;
      for (const provider of ["openai", "anthropic", "google", "bedrock"]) {
        for (const leased of [false, true]) {
          for (const plane of [null, new probes.FakeControlPlane()]) {
            const beforeCase = plane ? null : { budget: await budget(), totals: await totals() };
            const wire = captureControlPlane(plane?.apiUrl ?? apiUrl, plane?.fetch);
            const failure = new Error("synthetic mid-stream provider failure");
            const fixture = providerFixture(provider, { streamError: failure });
            const client = wrap(fixture, wire, provider, {
              leaseEnabled: leased,
              ...(plane ? { apiUrl: plane.apiUrl, apiKey: plane.apiKey } : {}),
            });
            const name = `sdk-live-stream-error-${provider}-${crypto.randomUUID()}`;
            let runId;
            try {
              await sdk.run(name, async () => {
                runId = sdk.currentRun().agentRunId;
                await assert.rejects(
                  async () => consume(await fixture.invoke(client, true)),
                  (error) => error === failure,
                );
              });
            } finally {
              await client.close();
            }
            assertDelivery(wire);
            assert.equal(fixture.calls, 1);
            assert.equal(fixture.ended, 1);
            const confirms = at(wire, "/budgets/confirm");
            assert.equal(confirms.length, leased ? 0 : 1);
            const events = metadata(wire);
            assert.equal(events.length, 1);
            assert.equal(events[0].status, "error");
            assert.equal(events[0].input_tokens, leased ? 0 : INPUT_TOKENS);
            assert.equal(events[0].output_tokens, leased ? 0 : OUTPUT_TOKENS);
            assert.equal(events[0].possibly_succeeded, true);
            assert.equal(events[0].failover_error_class, undefined);
            if (leased) {
              const leaseId = at(wire, "/budgets/lease")[0]?.response.lease_id;
              assert.equal(typeof leaseId, "string");
              assert.equal(at(wire, "/budgets/check").length, 0);
              assert.equal(events[0].token_details, undefined);
              assert.equal(events[0].lease_id, undefined);
              const surrenders = at(wire, "/lease/surrender");
              assert.equal(surrenders.length, 1);
              assert.equal(surrenders[0].request.lease_id, leaseId);
              assert.equal(surrenders[0].request.spent_tokens, 0);
            } else {
              assert.equal(at(wire, "/budgets/check").length, 1);
              assert.equal(at(wire, "/budgets/lease").length, 0);
              assert.equal(events[0].call_id, confirms[0].request.call_id);
              assert.equal(confirms[0].request.lease_id, undefined);
              assert.equal(
                confirms[0].request.reservation_id,
                at(wire, "/budgets/check")[0].response.reservation_id,
              );
              assert.equal(confirms[0].request.token_details.input_tokens, INPUT_TOKENS);
              assert.equal(confirms[0].request.token_details.output_tokens, OUTPUT_TOKENS);
            }
            if (!plane) {
              const caseCost = await assertRollup(runId, name, events);
              runCost += caseCost;
              const afterCase = { budget: await budget(), totals: await totals() };
              const budgetDelta = afterCase.budget.current_usage - beforeCase.budget.current_usage;
              const costDelta = afterCase.totals.total_cost - beforeCase.totals.total_cost;
              assert.equal(afterCase.totals.call_count - beforeCase.totals.call_count, 1);
              assert.ok(Math.abs(costDelta - caseCost) < 0.000001);
              assert.ok(Math.abs(budgetDelta - caseCost) < 0.000002);
              if (leased) {
                assert.equal(caseCost, 0);
                assert.equal(budgetDelta, 0);
              } else {
                assert.ok(caseCost > 0, "observed per-call usage must be billable exactly once");
              }
              t.diagnostic(
                `${provider} ${leased ? "lease" : "per-call"}: confirms=${confirms.length}, ` +
                  `tokens=${events[0].input_tokens}/${events[0].output_tokens}, ` +
                  `event cost=${caseCost.toFixed(8)}, budget delta=${budgetDelta.toFixed(8)}`,
              );
            }
          }
        }
      }
      const after = await totals();
      const afterBudget = await budget();
      assert.ok(runCost > 0, "observed usage on failed streams must be billable");
      assert.equal(after.call_count - before.call_count, 8);
      assert.equal(after.total_input_tokens - before.total_input_tokens, 4 * INPUT_TOKENS);
      assert.equal(after.total_output_tokens - before.total_output_tokens, 4 * OUTPUT_TOKENS);
      assert.ok(Math.abs(after.total_cost - before.total_cost - runCost) < 0.000001);
      assert.ok(
        Math.abs(afterBudget.current_usage - beforeBudget.current_usage - runCost) < 0.000002,
        `budget spend delta ${afterBudget.current_usage - beforeBudget.current_usage} differs from event spend ${runCost}`,
      );
    },
  );

  await t.test(
    "run-scoped lease grant, renewal on the next call, settlement attribution, and surrender",
    async () => {
      async function exerciseLease(plane) {
        const before = plane ? null : { totals: await totals(), budget: await budget() };
        const wire = captureControlPlane(plane?.apiUrl ?? apiUrl, plane?.fetch);
        const fixture = providerFixture("openai");
        const client = wrap(
          fixture,
          wire,
          "openai",
          plane ? { apiUrl: plane.apiUrl, apiKey: plane.apiKey } : {},
        );
        const name = `sdk-live-lease-${crypto.randomUUID()}`;
        let runId;
        try {
          await sdk.run(name, async () => {
            runId = sdk.currentRun().agentRunId;
            await fixture.invoke(client);
            const grant = at(wire, "/budgets/lease")[0];
            assert.equal(grant?.response.eligible, true, "the project must permit text leases");
            // Renewal starts on a call after the server's refresh deadline.
            // Allow for the SDK's 0.85..1.15 jitter without changing server time.
            await new Promise((resolve) =>
              setTimeout(resolve, Math.ceil(grant.response.refresh_interval_s * 1200)),
            );
            await consume(await fixture.invoke(client, true));
            await until(
              () => at(wire, "/lease/renew"),
              (rows) => rows.length > 0,
              15_000,
            );
          });
        } finally {
          await client.close();
        }
        assertDelivery(wire);
        const grants = at(wire, "/budgets/lease");
        assert.equal(grants.length, 1);
        assert.equal(grants[0].response.eligible, true);
        assert.equal(grants[0].response.allowed, true);
        const leaseId = grants[0].response.lease_id;
        assert.ok(at(wire, "/lease/renew").every((entry) => entry.response.lease_id === leaseId));
        assert.ok(at(wire, "/lease/surrender").some((entry) => entry.request.lease_id === leaseId));
        assert.equal(at(wire, "/budgets/confirm").length, 2);
        assert.ok(
          at(wire, "/budgets/confirm").every((entry) => entry.request.lease_id === leaseId),
        );
        const events = metadata(wire);
        assert.equal(events.length, 2);
        assert.ok(events.every((event) => event.lease_id === leaseId));
        if (!plane) {
          const cost = await assertRollup(runId, name, events);
          const after = await totals();
          const afterBudget = await budget();
          assert.equal(after.call_count - before.totals.call_count, 2);
          assert.ok(Math.abs(after.total_cost - before.totals.total_cost - cost) < 0.000001);
          assert.ok(
            Math.abs(afterBudget.current_usage - before.budget.current_usage - cost) < 0.000002,
          );
        }
      }
      await exerciseLease();
      await exerciseLease(new probes.FakeControlPlane({ refreshIntervalS: 0.1, leaseLengthS: 2 }));
    },
  );

  await t.test("untracked-surface reporting and provider-breaker reporting", async () => {
    for (const plane of [null, new probes.FakeControlPlane()]) {
      const wire = captureControlPlane(plane?.apiUrl ?? apiUrl, plane?.fetch);
      const fixture = providerFixture("openai");
      const client = wrap(
        fixture,
        wire,
        "openai",
        plane ? { apiUrl: plane.apiUrl, apiKey: plane.apiKey } : {},
      );
      try {
        await fixture.invoke(client);
        await client.syntheticResource.execute();
      } finally {
        await client.close();
      }
      assertDelivery(wire);
      const reports = at(wire, "/untracked-surfaces");
      assert.ok(
        reports.some((entry) =>
          entry.request.some((report) => report.surface === "syntheticResource.execute"),
        ),
      );
      assert.ok(reports.every((entry) => entry.response.accepted === entry.request.length));
      assert.ok(
        at(wire, "/breaker-reports").some(
          (entry) => entry.request.provider === "openai" && entry.response.accepted === true,
        ),
      );
    }
  });

  await t.test("ingest explicitly partitions fresh events and legacy/call replays", async () => {
    const stamp = new Date().toISOString();
    const event = {
      model: "gpt-4.1",
      provider: "openai",
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 0,
      status: "success",
      is_model_fallback: false,
      is_provider_fallback: false,
      call_id: crypto.randomUUID(),
      sdk_instance_id: `live-dedup-${crypto.randomUUID()}`,
      timestamp: stamp,
    };
    const legacy = { ...event, call_id: crypto.randomUUID() };
    const fresh = {
      ...event,
      call_id: crypto.randomUUID(),
      sdk_instance_id: `live-dedup-${crypto.randomUUID()}`,
    };
    const body = [event, legacy, fresh];
    const real = await request("POST", "/metadata/ingest", body, 202);
    const plane = new probes.FakeControlPlane();
    const fake = plane.handle("POST", "/api/v1/metadata/ingest", body).body;
    assert.deepEqual(real, fake);
    assert.deepEqual(real, {
      ingested: 2,
      rejected: [],
      duplicates: [{ index: 1, reason: "legacy_key", call_id: legacy.call_id }],
    });
    const replay = await request("POST", "/metadata/ingest", [event], 202);
    assert.equal(replay.ingested, 0);
    assert.deepEqual(replay.rejected, []);
    assert.equal(replay.duplicates.length, 1);
    assert.equal(replay.duplicates[0].call_id, event.call_id);
    assert.ok(["legacy_key", "call_id"].includes(replay.duplicates[0].reason));
  });

  await t.test("public confirm and receipt-ingest contract probes", async (sub) => {
    for (const name of ["assertConfirmContract", "assertReceiptIngestContract"]) {
      await sub.test(name, () => probes[name](probeFetch, options));
    }
  });

  await t.test("policy and stop scenarios on a disposable project", { skip: !jwt }, async (sub) => {
    const original = await budget();
    const originalPolicy = {
      limit_usd: original.budget_limit,
      period: original.budget_period,
      mode: original.budget_mode,
      sub_period: original.sub_period,
      sub_limit_usd: original.sub_limit,
      thresholds: original.thresholds.map(
        ({ rule_key: _key, routing: _routing, current_usage: _usage, ...rule }) => rule,
      ),
    };
    const basePolicy = { limit_usd: 1000, period: "monthly", mode: "alert_only", thresholds: [] };
    const policy = (value = basePolicy) => request("PUT", `${projectPath}/budget`, value, 200, jwt);

    async function stopRun(runId, name) {
      const result = await until(
        () => runRow(runId, name),
        (value) => value !== null,
      );
      const stopped = await request(
        "POST",
        `${projectPath}/agent-runs/${result.row.id}/stop`,
        undefined,
        200,
        jwt,
      );
      assert.equal(stopped.run_id, result.row.id);
      assert.equal(typeof stopped.stopped_at, "string");
    }

    async function seedStoppedRun(runId) {
      const name = `sdk-live-stop-seed-${crypto.randomUUID()}`;
      await request(
        "POST",
        "/metadata/ingest",
        [
          {
            model: "gpt-4.1",
            provider: "openai",
            input_tokens: 1,
            output_tokens: 0,
            latency_ms: 0,
            status: "budget_denied",
            is_model_fallback: false,
            call_id: crypto.randomUUID(),
            sdk_instance_id: `live-seed-${crypto.randomUUID()}`,
            timestamp: new Date().toISOString(),
            agent_run_id: runId,
            agent_run_name: name,
            deny_source: "server",
            deny_reason: "monthly",
            denied_by_period: "monthly",
          },
        ],
        202,
      );
      const events = await request(
        "GET",
        `${projectPath}/costs/events?range=7d&limit=100&agent_run=${encodeURIComponent(runId)}`,
      );
      assert.ok(events.items.length > 0);
      await request(
        "POST",
        `${projectPath}/agent-runs/${events.items[0].agent_run_id}/stop`,
        undefined,
        200,
        jwt,
      );
    }

    try {
      await policy();
      await sub.test(
        "hard deny prevents provider dispatch and drains a denial receipt",
        async () => {
          await policy({ ...basePolicy, limit_usd: 0.000001, mode: "hard_deny" });
          const fake = new probes.FakeControlPlane({ mode: "hard_deny" });
          fake.denyNext(1, { period: "monthly" });
          for (const plane of [null, fake]) {
            const wire = captureControlPlane(plane?.apiUrl ?? apiUrl, plane?.fetch);
            const fixture = providerFixture("openai");
            const client = wrap(
              fixture,
              wire,
              "openai",
              plane ? { apiUrl: plane.apiUrl, apiKey: plane.apiKey } : {},
            );
            try {
              await assert.rejects(fixture.invoke(client), sdk.BudgetExceededError);
            } finally {
              await client.close();
              if (!plane) await policy();
            }
            assertDelivery(wire);
            assert.equal(fixture.calls, 0);
            assert.equal(at(wire, "/budgets/check")[0].response.denied_by_period, "monthly");
            assert.equal(metadata(wire)[0].status, "budget_denied");
            assert.equal(metadata(wire)[0].output_tokens, 0);
          }
        },
      );

      await sub.test("manual_kill blocks a future call and aborts an active stream", async () => {
        for (const plane of [null, new probes.FakeControlPlane()]) {
          const wire = captureControlPlane(plane?.apiUrl ?? apiUrl, plane?.fetch);
          const fixture = providerFixture("openai");
          const client = wrap(fixture, wire, "openai", {
            leaseEnabled: false,
            ...(plane ? { apiUrl: plane.apiUrl, apiKey: plane.apiKey } : {}),
          });
          const name = `sdk-live-manual-kill-${crypto.randomUUID()}`;
          try {
            await sdk.run(name, async () => {
              const runId = sdk.currentRun().agentRunId;
              await fixture.invoke(client);
              await until(
                () => metadata(wire).length,
                (value) => value > 0,
              );
              const stream = await fixture.invoke(client, true);
              const iterator = stream[Symbol.asyncIterator]();
              assert.equal((await iterator.next()).done, false);
              if (plane) plane.stopRun(runId);
              else await stopRun(runId, name);
              const manualKill = (error) => {
                assert.ok(error instanceof sdk.RunStoppedError);
                assert.equal(error.reason, "manual_kill");
                assert.equal(error.agentRunId, runId);
                return true;
              };
              await assert.rejects(fixture.invoke(client), manualKill);
              await assert.rejects(iterator.next(), manualKill);
            });
          } finally {
            await client.close();
          }
          assertDelivery(wire);
          assert.equal(fixture.calls, 2);
          assert.equal(fixture.ended, 1);
        }
      });

      await sub.test("assertCheckContract", async () => {
        await seedStoppedRun("contract-stopped-run");
        const liveFetch = async (input, init) => {
          const body = JSON.parse(init.body);
          if (body.tags?.contract_case === "monthly") {
            await policy({ ...basePolicy, limit_usd: 0.000001, mode: "hard_deny" });
          } else {
            const thresholds = [];
            if (body.tags?.customer === "acme")
              thresholds.push({
                type: "scoped_budget",
                scope: "tag",
                match: "customer",
                match_value: "acme",
                limit: 0.000001,
                mode: "hard_deny",
                channel_ids: [],
              });
            if (body.agent_run_id === "contract-agent-run")
              thresholds.push({
                type: "scoped_budget",
                scope: "agent_run",
                match: body.agent_run_id,
                limit: 0.000001,
                mode: "hard_deny",
                channel_ids: [],
              });
            await policy({ ...basePolicy, thresholds });
          }
          return probeFetch(input, init);
        };
        try {
          await probes.assertCheckContract(liveFetch, options);
        } finally {
          await policy();
        }
      });

      await sub.test("assertLeaseContract", async () => {
        const held = [];
        try {
          for (let index = 0; index < 32; index++) {
            const holder = `live-cap-holder-${index}`;
            const grant = await request("POST", "/budgets/lease", {
              agent_run_id: "contract-holder-cap",
              holder_id: holder,
              model: "gpt-5.5",
              provider: "openai",
              fail_open: true,
              estimated_input_tokens: 1000,
            });
            assert.equal(grant.eligible, true);
            assert.equal(grant.allowed, true);
            held.push({
              lease_id: grant.lease_id,
              holder_id: holder,
              generation: grant.generation,
              spent_tokens: 0,
            });
          }
          const liveFetch = async (input, init) => {
            if (input.endsWith("/budgets/lease")) {
              const body = JSON.parse(init.body);
              await policy(
                body.agent_run_id === "contract-lease-denied"
                  ? { ...basePolicy, limit_usd: 0.000001, mode: "hard_deny" }
                  : basePolicy,
              );
            }
            return probeFetch(input, init);
          };
          await probes.assertLeaseContract(liveFetch, options);
        } finally {
          await policy();
          for (const lease of held) await request("POST", "/budgets/lease/surrender", lease);
        }
      });

      await sub.test("assertRunControlContract", async () => {
        const stoppedRunId = `live-contract-stopped-${crypto.randomUUID()}`;
        await seedStoppedRun(stoppedRunId);
        await probes.assertRunControlContract(probeFetch, { ...options, stoppedRunId });
      });
    } finally {
      await policy(originalPolicy);
    }
  });
});
