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
// ---------------------------------------------------------------------------
// Payload ownership. A held wrapped handle must not keep consumed stream payloads, or the
// request of an unfinished stream, reachable. Every payload below is synthetic.
// ---------------------------------------------------------------------------
const HELD = 8;
const payloadClients: { close(): Promise<void> }[] = [];
const alive = (refs: readonly WeakRef<object>[]): number =>
  refs.filter((ref) => ref.deref() !== undefined).length;
const encoder = new TextEncoder();
/** SSE body; `failAfter` errors the body after that many events (a mid-stream disconnect). */
function sseBody(events: readonly unknown[], failAfter?: number): Response {
  const frames = events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      // Pull-driven: erroring a stream discards chunks still queued, so deliver first.
      pull(controller) {
        if (index === failAfter) controller.error(new Error("synthetic disconnect"));
        else if (index === frames.length) controller.close();
        else controller.enqueue(frames[index++] as Uint8Array);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
/** An async iterator that drops each item once handed out, so it never retains payloads. */
function releasingIterator(items: unknown[], failAt?: number): AsyncIterableIterator<unknown> {
  let index = 0;
  const iterator: AsyncIterableIterator<unknown> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      if (index === failAt) {
        items.length = 0;
        throw new Error("synthetic stream failure");
      }
      if (index >= items.length) {
        items.length = 0;
        return { done: true, value: undefined };
      }
      const value = items[index];
      items[index++] = undefined;
      return { done: false, value };
    },
    return: async () => {
      items.length = 0;
      return { done: true, value: undefined };
    },
  };
  return iterator;
}
const payloadOptions = { ...options, circuitBreakerFailureThreshold: 1000 };

// OpenAI Responses: the terminal snapshot carries generated output plus echoed instructions
// and tools. A trailing event lets a consumer close after the terminal event, mid-stream.
const responsesBase = {
  id: "resp_payload",
  object: "response",
  model: "gpt-4o-mini",
  instructions: "i".repeat(16 * 1024),
  tools: [
    {
      type: "function",
      name: "lookup",
      description: "d".repeat(4 * 1024),
      parameters: { type: "object", properties: {} },
      strict: true,
    },
  ],
};
const responsesEvents = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { ...responsesBase, status: "in_progress", output: [], usage: null },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_payload",
    output_index: 0,
    content_index: 0,
    delta: "x",
  },
  {
    type: "response.completed",
    sequence_number: 2,
    response: {
      ...responsesBase,
      status: "completed",
      service_tier: "default",
      output: [
        {
          id: "msg_payload",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "x".repeat(64 * 1024), annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  },
  { type: "response.synthetic_trailer", sequence_number: 3 },
];
// OpenAI chat: a compatible-style terminal chunk carries both a content delta and usage.
const chatChunks = [
  {
    id: "chat_payload",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
  },
  {
    id: "chat_payload",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content: "x".repeat(64 * 1024) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  },
  { id: "chat_payload", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [] },
];
let providerFailAfter: number | undefined;
const openaiPayload = new Solwyn(
  new OpenAI({
    apiKey: "offline",
    maxRetries: 0,
    fetch: async (url: string | URL | Request) =>
      sseBody(String(url).endsWith("/responses") ? responsesEvents : chatChunks, providerFailAfter),
  }),
  payloadOptions,
);
payloadClients.push(openaiPayload);

// Google (duck-typed, multi-chunk): each call records its chunks before handing them over.
let googleFailAt: number | undefined;
let googleFirst: object | undefined;
const googlePayload = new Solwyn(
  {
    models: {
      generateContent: async (_params: unknown) => ({}),
      generateContentStream: async (_params: {
        model: string;
        contents: unknown;
        config?: unknown;
      }): Promise<AsyncIterableIterator<unknown>> => {
        const chunks = [
          { candidates: [{ content: { role: "model", parts: [{ text: "first" }] } }] },
          { candidates: [{ content: { role: "model", parts: [{ text: "middle" }] } }] },
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "." }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
          },
        ];
        googleFirst = chunks[0];
        return releasingIterator(chunks, googleFailAt);
      },
    },
  },
  payloadOptions,
);
payloadClients.push(googlePayload);

type Path =
  | "exhausted"
  | "early_closed"
  | "closed_before_first_iteration"
  | "errored"
  | "mid_stream";
async function iterateResponses(path: Path, output: WeakRef<object>[], tools: WeakRef<object>[]) {
  providerFailAfter = path === "errored" ? 3 : undefined;
  const stream = await openaiPayload.responses.create({
    model: "gpt-4o-mini",
    input: "offline",
    stream: true,
  });
  try {
    for await (const event of stream) {
      if (event.type !== "response.completed") continue;
      output.push(new WeakRef(event.response.output));
      tools.push(new WeakRef(event.response.tools));
      if (path === "early_closed") break;
    }
    assert.notEqual(path, "errored", "the errored Responses stream must throw");
  } catch (error) {
    assert.equal(path, "errored");
    assert.equal((error as Error).message, "synthetic disconnect");
  }
  return stream;
}
async function iterateChat(path: Path, choices: WeakRef<object>[]) {
  providerFailAfter = undefined;
  const stream = await openaiPayload.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "offline" }],
    stream: true,
    stream_options: { include_usage: true },
  });
  for await (const chunk of stream) {
    if (chunk.usage == null) continue;
    choices.push(new WeakRef(chunk.choices));
    if (path === "early_closed") break;
  }
  return stream;
}
async function iterateGoogle(path: Path, candidates: WeakRef<object>[]) {
  googleFailAt = path === "errored" ? 1 : undefined;
  const stream = await googlePayload.models.generateContentStream({
    model: "gemini-2.5-flash",
    contents: "offline",
  });
  const first = googleFirst as { candidates: object };
  googleFirst = undefined;
  candidates.push(new WeakRef(first.candidates));
  if (path === "closed_before_first_iteration") {
    await (stream as unknown as { close(): Promise<void> }).close();
    return stream;
  }
  let deliveries = 0;
  let index = 0;
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done === true) break;
      if (next.value === first) deliveries++;
      if (index++ === 0) assert.equal(next.value, first, "first chunk keeps its identity");
      if (path === "early_closed") {
        await iterator.return?.();
        break;
      }
      if (path === "mid_stream" && index === 2) break;
    }
    assert.notEqual(path, "errored", "the errored Google stream must throw");
  } catch (error) {
    assert.equal(path, "errored");
    assert.equal((error as Error).message, "synthetic stream failure");
  }
  assert.equal(deliveries, 1, `google ${path}: first chunk is delivered exactly once`);
  return stream;
}
async function payloadRetention(): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  const held: unknown[] = [];
  for (const path of ["exhausted", "early_closed", "errored"] as const) {
    const output: WeakRef<object>[] = [];
    const tools: WeakRef<object>[] = [];
    for (let index = 0; index < HELD; index++)
      held.push(await iterateResponses(path, output, tools));
    assert.equal(output.length, HELD);
    await collect();
    out[`responses_${path}`] = { output: alive(output), tools: alive(tools) };
  }
  for (const path of ["exhausted", "early_closed"] as const) {
    const choices: WeakRef<object>[] = [];
    for (let index = 0; index < HELD; index++) held.push(await iterateChat(path, choices));
    assert.equal(choices.length, HELD);
    await collect();
    out[`chat_${path}`] = { choices: alive(choices) };
  }
  for (const path of [
    "exhausted",
    "early_closed",
    "closed_before_first_iteration",
    "errored",
    "mid_stream",
  ] as const) {
    const candidates: WeakRef<object>[] = [];
    for (let index = 0; index < HELD; index++) held.push(await iterateGoogle(path, candidates));
    await collect();
    out[`google_${path}`] = { first_candidates: alive(candidates) };
  }
  assert.equal(held.length, HELD * 10, "every wrapped handle stays held while measured");
  return out;
}

// Unfinished streams: held, never-iterated wrapped streams must not keep the request alive.
const REQUESTS = 10;
async function openHeldStream(kind: "chat" | "responses" | "google", refs: WeakRef<object>[]) {
  const content = "q".repeat(16 * 1024);
  providerFailAfter = undefined;
  googleFailAt = undefined;
  if (kind === "chat") {
    const messages = [{ role: "user" as const, content }];
    refs.push(new WeakRef(messages));
    return openaiPayload.chat.completions.create({ model: "gpt-4o", messages, stream: true });
  }
  if (kind === "responses") {
    const input = [{ role: "user" as const, content }];
    refs.push(new WeakRef(input));
    return openaiPayload.responses.create({ model: "gpt-4o-mini", input, stream: true });
  }
  const contents = [{ role: "user", parts: [{ text: content }] }];
  refs.push(new WeakRef(contents));
  const stream = await googlePayload.models.generateContentStream({
    model: "gemini-2.5-flash",
    contents,
  });
  googleFirst = undefined;
  return stream;
}
async function requestRetention(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const held: unknown[] = [];
  for (const kind of ["chat", "responses", "google"] as const) {
    const refs: WeakRef<object>[] = [];
    for (let index = 0; index < REQUESTS; index++) held.push(await openHeldStream(kind, refs));
    await collect();
    out[kind] = alive(refs);
  }
  assert.equal(held.length, REQUESTS * 3, "every unfinished stream stays held while measured");
  for (const stream of held) await (stream as { close(): Promise<void> }).close();
  return out;
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
  results["payload_retention"] = await payloadRetention();
  results["request_retention"] = await requestRetention();
  process.stdout.write(JSON.stringify({ ok: true, ...results }));
} finally {
  for (const client of [...Object.values(clients), ...payloadClients]) await client.close();
  LeaseLedger.prototype.applyGrantResponse = apply;
  globalThis.fetch = originalFetch;
}
