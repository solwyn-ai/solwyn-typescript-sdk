import assert from "node:assert/strict";

export const SENTINEL = "synthetic live integration text";
export const INPUT_TOKENS = 1000;
export const OUTPUT_TOKENS = 500;

/** Record only control-plane JSON, never authorization headers or provider content. */
export function captureControlPlane(apiUrl, delegate = globalThis.fetch) {
  const base = new URL(apiUrl);
  assert.ok(["http:", "https:"].includes(base.protocol), "expected an HTTP control plane");
  const prefix = `${base.pathname.replace(/\/$/, "")}/api/v1/`;
  const exchanges = [];
  let pending = 0;
  return {
    exchanges,
    get pending() {
      return pending;
    },
    fetch: async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, base.origin, "request escaped the selected control plane");
      assert.ok(url.pathname.startsWith(prefix), "request escaped the control-plane API");
      pending++;
      try {
        const response = await delegate(input, init);
        const text = await response.clone().text();
        exchanges.push({
          path: url.pathname,
          request: init?.body ? JSON.parse(init.body) : null,
          status: response.status,
          response: text ? JSON.parse(text) : null,
        });
        return response;
      } finally {
        pending--;
      }
    },
  };
}

export async function until(read, accepts, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, "control-plane state did not converge before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function at(wire, suffix) {
  return wire.exchanges.filter((exchange) => exchange.path.endsWith(suffix));
}

export function metadata(wire) {
  return at(wire, "/metadata/ingest").flatMap((exchange) => exchange.request);
}

export function assertDelivery(wire) {
  assert.equal(wire.pending, 0, "close() left control-plane requests in flight");
  for (const exchange of wire.exchanges) {
    assert.ok(exchange.status < 300, `${exchange.path} returned HTTP ${exchange.status}`);
    if (exchange.path.endsWith("/metadata/ingest")) {
      assert.deepEqual(exchange.response.rejected, [], "metadata was rejected");
      assert.deepEqual(exchange.response.duplicates, [], "fresh metadata was duplicated");
      assert.equal(exchange.response.ingested, exchange.request.length);
    }
  }
  assert.ok(
    !JSON.stringify(wire.exchanges).includes(SENTINEL),
    "provider content crossed the firewall",
  );
}

class ConverseCommand {
  constructor(input) {
    this.input = input;
  }
}

class ConverseStreamCommand extends ConverseCommand {}

/** Plain objects only: no provider SDK, credentials, HTTP transport, or provider fetch. */
export function providerFixture(provider, { onClose = () => {} } = {}) {
  let calls = 0;
  let ended = 0;
  let closed = false;
  const close = async () => {
    closed = true;
    onClose();
  };
  async function* stream(chunks) {
    try {
      for (const chunk of chunks) yield chunk;
    } finally {
      ended++;
    }
  }
  let raw;
  let model;
  let invoke;
  if (provider === "openai") {
    model = "gpt-4.1";
    raw = {
      close,
      chat: {
        completions: {
          create: async (params) => {
            calls++;
            return params.stream
              ? stream([
                  { choices: [{ delta: { content: SENTINEL }, finish_reason: null }] },
                  {
                    choices: [],
                    usage: { prompt_tokens: INPUT_TOKENS, completion_tokens: OUTPUT_TOKENS },
                  },
                ])
              : {
                  choices: [],
                  usage: { prompt_tokens: INPUT_TOKENS, completion_tokens: OUTPUT_TOKENS },
                };
          },
        },
      },
      // An unknown operation exercises the public untracked-surface reporter.
      syntheticResource: { execute: async () => ({ ok: true }) },
    };
    invoke = (client, streaming = false) =>
      client.chat.completions.create({
        model,
        messages: [{ role: "user", content: SENTINEL }],
        max_tokens: OUTPUT_TOKENS,
        stream: streaming,
      });
  } else if (provider === "anthropic") {
    model = "claude-sonnet-4-5";
    raw = {
      close,
      messages: {
        create: async (params) => {
          calls++;
          return params.stream
            ? stream([
                { type: "message_start", message: { usage: { input_tokens: INPUT_TOKENS } } },
                { type: "message_delta", usage: { output_tokens: OUTPUT_TOKENS } },
                { type: "message_stop" },
              ])
            : { usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS } };
        },
      },
    };
    invoke = (client, streaming = false) =>
      client.messages.create({
        model,
        messages: [{ role: "user", content: SENTINEL }],
        max_tokens: OUTPUT_TOKENS,
        stream: streaming,
      });
  } else if (provider === "google") {
    model = "gemini-2.5-flash";
    const usageMetadata = { promptTokenCount: INPUT_TOKENS, candidatesTokenCount: OUTPUT_TOKENS };
    raw = {
      close,
      models: {
        generateContent: async () => {
          calls++;
          return { usageMetadata };
        },
        generateContentStream: async () => {
          calls++;
          return stream([{ candidates: [] }, { usageMetadata }]);
        },
      },
    };
    invoke = (client, streaming = false) =>
      client.models[streaming ? "generateContentStream" : "generateContent"]({
        model,
        contents: SENTINEL,
        config: { maxOutputTokens: OUTPUT_TOKENS },
      });
  } else {
    assert.equal(provider, "bedrock");
    model = "anthropic.claude-3-5-sonnet-20241022-v2:0";
    const usage = { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS };
    class BedrockRuntimeClient {
      config = { region: "us-east-1" };
      close = close;
      async send(command) {
        calls++;
        return command instanceof ConverseStreamCommand
          ? { stream: stream([{ messageStart: { role: "assistant" } }, { metadata: { usage } }]) }
          : { usage };
      }
    }
    raw = new BedrockRuntimeClient();
    invoke = (client, streaming = false) =>
      client.send(
        new (streaming ? ConverseStreamCommand : ConverseCommand)({
          modelId: model,
          messages: [{ role: "user", content: [{ text: SENTINEL }] }],
          inferenceConfig: { maxTokens: OUTPUT_TOKENS },
        }),
      );
  }
  return {
    raw,
    model,
    invoke,
    get calls() {
      return calls;
    },
    get ended() {
      return ended;
    },
    get closed() {
      return closed;
    },
  };
}

export async function consume(response) {
  let count = 0;
  for await (const _chunk of response.stream ?? response) count++;
  assert.ok(count > 0, "the provider stream was empty");
}
