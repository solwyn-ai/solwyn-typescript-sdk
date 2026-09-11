/**
 * Dist smoke harness. Loads a BUILT package entry (ESM `dist/index.js` or CJS
 * `dist/index.cjs`, passed as argv[2]) exactly the way a consumer's Node would — via a
 * real dynamic `import()`, with NO bundler/vitest module resolution in the path — then:
 *
 *   1. constructs `new Solwyn(fakeOpenAIClient, { apiKey, fetch, logger })`,
 *   2. performs ONE intercepted `chat.completions.create()` call, and
 *   3. prints a JSON result describing whether it dispatched and when the code-split
 *      openai adapter chunk was loaded (laziness).
 *
 * This is the regression guard for the loader-build defect: with a runtime-variable
 * dynamic import specifier the built artifact throws ERR_MODULE_NOT_FOUND on this exact
 * call. No provider SDK is installed/imported — the fake client is a plain object.
 */

import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";

const entry = process.argv[2];
if (entry === undefined) {
  throw new Error("harness: missing entry path argument");
}

// Register a loader hook that reports whenever the openai adapter chunk is loaded.
const { port1, port2 } = new MessageChannel();
const loadedChunks = [];
const pendingBarriers = new Map();
let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});
port1.on("message", (message) => {
  if (message?.type === "ready") {
    resolveReady();
    return;
  }
  if (message?.type === "loaded") {
    loadedChunks.push(message.url);
    return;
  }
  if (message?.type === "barrier") {
    pendingBarriers.get(message.id)?.();
    pendingBarriers.delete(message.id);
  }
});
port1.unref();
register("./load-recorder.mjs", import.meta.url, {
  data: port2,
  transferList: [port2],
});

function withTimeout(promise, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`harness: timed out waiting for ${label}`)),
        5_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

let nextBarrierId = 0;
async function barrier(label) {
  const id = ++nextBarrierId;
  const acknowledged = new Promise((resolve) => {
    pendingBarriers.set(id, resolve);
  });
  port1.postMessage({ type: "barrier", id });
  await withTimeout(acknowledged, label);
}

await withTimeout(ready, "loader readiness");

// Import the built entry the way a consumer would (dynamic import resolves CJS too).
const sdk = await import(entry);
const { Solwyn } = sdk;
if (typeof Solwyn !== "function") {
  throw new Error(`harness: built entry ${entry} did not export Solwyn`);
}

// A fake, provider-SDK-free OpenAI-shaped client (detected structurally via
// chat.completions.create). Records the kwargs it receives so we can prove dispatch.
let dispatchedArgs = null;
const fakeClient = {
  chat: {
    completions: {
      create(kwargs) {
        dispatchedArgs = kwargs;
        return { id: "resp_smoke", usage: { prompt_tokens: 3, completion_tokens: 5 } };
      },
    },
  },
};

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const fetchStub = async () => new Response("[]", { status: 202 });
const apiKey = `sk_proj_${"a".repeat(64)}`;

const client = new Solwyn(fakeClient, { apiKey, fetch: fetchStub, logger: noopLogger });

// A FIFO barrier guarantees all earlier loader messages have been observed before snapshotting.
await barrier("pre-call loader barrier");
const loadedBeforeCall = [...loadedChunks];

const result = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
});

await barrier("post-call loader barrier");
const loadedAfterCall = [...loadedChunks];

await client.close();

const dispatched =
  dispatchedArgs !== null &&
  typeof result === "object" &&
  result !== null &&
  result.id === "resp_smoke";

process.stdout.write(`${JSON.stringify({ dispatched, loadedBeforeCall, loadedAfterCall })}\n`);
