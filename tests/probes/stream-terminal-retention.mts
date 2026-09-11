import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { LeaseLedger, type LeaseState } from "../../src/lease";
import { noopLogger, run, Solwyn } from "../../src/node";
import { getCurrentRun } from "../../src/run-context";
import type { FetchLike } from "../../src/transport";

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");
async function collect(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await setImmediate();
    forceGc?.();
  }
  await setImmediate();
}
const states: WeakRef<LeaseState>[] = [];
const lifetimes: WeakRef<object>[] = [];
async function collectCompleted(): Promise<void> {
  // Finalizer callbacks can enqueue asynchronous surrenders. Give that bounded
  // cleanup chain several collection turns rather than assuming one GC cadence.
  for (let attempt = 0; attempt < 8; attempt++) {
    await collect();
    if (
      states.every((ref) => ref.deref() === undefined) &&
      lifetimes.every((ref) => ref.deref() === undefined)
    )
      return;
  }
}
const apply = LeaseLedger.prototype.applyGrantResponse;
LeaseLedger.prototype.applyGrantResponse = function (runId, response, options) {
  const result = apply.call(this, runId, response, options);
  const state = this.stateFor(runId);
  if (state) states.push(new WeakRef(state));
  return result;
};
let grants = 0;
let surrenders = 0;
const fetch: FetchLike = async (url, init) => {
  if (url.endsWith("/budgets/lease")) {
    grants++;
    return Response.json({
      eligible: true,
      allowed: true,
      lease_id: `lease-${grants}`,
      generation: 1,
      granted_tokens: 2000,
      refresh_interval_s: 300,
      lease_length_s: 600,
      headroom_share_tokens: 0,
      posture: { mode: "hard_deny", on_unreachable: "local_enforce" },
      final_grant: true,
      project_id: `proj_${"0".repeat(24)}`,
      mode: "hard_deny",
      budget_limit: 100,
      current_usage: 0,
      remaining_budget: 100,
    });
  }
  if (url.endsWith("/budgets/check"))
    return Response.json({
      allowed: true,
      remaining_budget: 100,
      reservation_id: null,
      mode: "hard_deny",
      budget_limit: 100,
      current_usage: 0,
      denied_by_period: null,
      project_id: `proj_${"0".repeat(24)}`,
      price_hints: null,
    });
  if (url.endsWith("/metadata/ingest"))
    return Response.json(
      {
        ingested: JSON.parse(String(init?.body)).length,
        rejected: [],
      },
      { status: 202 },
    );
  if (url.endsWith("/budgets/lease/surrender")) surrenders++;
  if (url.endsWith("/budgets/confirm") || url.endsWith("/budgets/lease/surrender"))
    return new Response(null, { status: 204 });
  throw new Error("unexpected mocked stream accounting endpoint");
};
const options = {
  apiKey: `sk_proj_${"a".repeat(64)}`,
  apiUrl: "https://stream-retention.invalid",
  fetch,
  logger: noopLogger,
  reportUntrackedSurfaces: false,
  breakerReportingEnabled: false,
  velocityMode: "off" as const,
};
const originalFetch = globalThis.fetch;
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const response = {
  id: "resp_retention",
  object: "response",
  status: "completed",
  output: [],
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
};
const clients = {
  plain: new Solwyn(
    {
      chat: {
        completions: {
          create: async (_params: { model: string; max_tokens: number; stream: boolean }) =>
            (async function* () {
              yield { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } };
            })(),
        },
      },
    },
    options,
  ),
  responses: new Solwyn(
    new OpenAI({
      apiKey: "offline",
      maxRetries: 0,
      fetch: async () =>
        sse([
          {
            type: "response.created",
            sequence_number: 0,
            response: { ...response, status: "in_progress" },
          },
          { type: "response.completed", sequence_number: 1, response },
        ]),
    }),
    options,
  ),
  google: new Solwyn(new GoogleGenAI({ apiKey: "offline" }), options),
  translated: new Solwyn(
    {
      chat: {
        completions: {
          create: async (_params: {
            model: string;
            max_tokens: number;
            stream: boolean;
            messages: never[];
          }): Promise<AsyncIterable<unknown>> => {
            throw Object.assign(new Error(), { status: 429 });
          },
        },
      },
    },
    {
      ...options,
      circuitBreakerFailureThreshold: 1000,
      fallback: [
        [
          {
            messages: {
              create: async () =>
                (async function* () {
                  yield {
                    type: "message_start",
                    message: {
                      id: "msg_retention",
                      type: "message",
                      role: "assistant",
                      model: "claude-sonnet-4-6",
                      content: [],
                      usage: { input_tokens: 0, output_tokens: 0 },
                    },
                  };
                  yield {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 0 },
                  };
                  yield { type: "message_stop" };
                })(),
            },
          },
          "claude-sonnet-4-6",
        ],
      ],
    },
  ),
};
globalThis.fetch = async () =>
  sse([{ usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }]);
const results: Record<string, unknown> = {};
const keepAlive: unknown[] = [];
function captureLifetime(): void {
  const lifetime = getCurrentRun()?.lifetime;
  assert.ok(lifetime);
  lifetimes.push(new WeakRef(lifetime));
}
try {
  for (const mode of ["plain", "responses", "google", "translated"] as const) {
    const initialStates = states.length;
    const initialSurrenders = surrenders;
    for (let index = 0; index < 30; index++) {
      await run(`terminal-${mode}`, async () => {
        captureLifetime();
        if (mode === "responses") {
          const stream = clients.responses.responses.stream({
            model: "gpt-4o",
            input: [],
            max_output_tokens: 1,
          });
          assert.equal((await stream.finalResponse()).id, response.id);
          keepAlive.push(stream);
          return;
        }
        if (mode === "translated") {
          const stream = await clients.translated.chat.completions.create({
            model: "gpt-4o",
            max_tokens: 1,
            messages: [],
            stream: true,
          });
          for await (const item of stream) void item;
          keepAlive.push(stream);
          return;
        }
        const stream =
          mode === "plain"
            ? await clients.plain.chat.completions.create({
                model: "gpt-4o",
                max_tokens: 1,
                stream: true,
              })
            : await clients.google.models.generateContentStream({
                model: "gemini-2.5-flash",
                contents: [{ role: "user", parts: [] }],
                config: { maxOutputTokens: 1 },
              });
        for await (const item of stream) void item;
        keepAlive.push(stream);
      });
    }
    await collectCompleted();
    const aliveStates = states.filter((ref) => ref.deref() !== undefined).length;
    const aliveLifetimes = lifetimes.filter((ref) => ref.deref() !== undefined).length;
    assert.equal(aliveStates, 0, `${mode}: retained terminal wrappers must release lease states`);
    assert.equal(
      aliveLifetimes,
      0,
      `${mode}: retained terminal wrappers must release lifetime ownership`,
    );
    results[mode] = {
      retained: 30,
      states: states.length - initialStates,
      aliveStates,
      aliveLifetimes,
      surrenders: surrenders - initialSurrenders,
    };
  }
  // Public terminal helpers still provide the cached native result after reclamation.
  for (const stream of keepAlive.slice(30, 60) as ReturnType<
    typeof clients.responses.responses.stream
  >[]) {
    assert.equal((await stream.finalResponse()).id, response.id);
    await stream.done();
  }
  // A scope may return an active stream; it owns its lease until terminal settlement.
  const active = await run("still-active", async () => {
    captureLifetime();
    return clients.plain.chat.completions.create({ model: "gpt-4o", max_tokens: 1, stream: true });
  });
  await collect();
  assert.equal(states.filter((ref) => ref.deref() !== undefined).length, 1);
  assert.equal(lifetimes.filter((ref) => ref.deref() !== undefined).length, 1);
  for await (const item of active) void item;
  keepAlive.push(active);
  await collectCompleted();
  assert.equal(states.filter((ref) => ref.deref() !== undefined).length, 0);
  assert.equal(lifetimes.filter((ref) => ref.deref() !== undefined).length, 0);
  results["active_stream"] = true;
  assert.equal(keepAlive.length, 121);
  process.stdout.write(JSON.stringify({ ok: true, ...results }));
} finally {
  for (const client of Object.values(clients)) await client.close();
  LeaseLedger.prototype.applyGrantResponse = apply;
  globalThis.fetch = originalFetch;
}
