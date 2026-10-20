import type OpenAI from "openai";

export interface FakeOpenAIRequest {
  readonly url: string;
  readonly method: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface FakeOpenAITransportOptions {
  /** HTTP status or per-attempt sequence (the last status repeats). */
  readonly status?: number | readonly number[];
  /** Synthetic test output only. */
  readonly reply?: string;
}

export interface FakeOpenAITransport {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly FakeOpenAIRequest[];
}

const CREATED_AT = 1_700_000_000;
const CHAT_USAGE: OpenAI.Completions.CompletionUsage = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
  completion_tokens_details: {
    reasoning_tokens: 0,
    audio_tokens: 0,
    accepted_prediction_tokens: 0,
    rejected_prediction_tokens: 0,
  },
};

function chatCompletion(model: string, reply: string): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl_synthetic",
    object: "chat.completion",
    created: CREATED_AT,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply, refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: CHAT_USAGE,
  };
}

function chatChunks(model: string, reply: string): OpenAI.Chat.Completions.ChatCompletionChunk[] {
  const base = {
    id: "chatcmpl_synthetic",
    object: "chat.completion.chunk",
    created: CREATED_AT,
    model,
  } as const;
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      usage: null,
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
      usage: null,
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
    { ...base, choices: [], usage: CHAT_USAGE },
  ];
}

function completedResponse(model: string, reply: string): OpenAI.Responses.Response {
  return {
    id: "resp_synthetic",
    object: "response",
    access_programs: null,
    created_at: CREATED_AT,
    completed_at: CREATED_AT,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output_text: reply,
    output: [
      {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: reply, annotations: [], logprobs: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 18,
    },
    metadata: {},
  };
}

function responseEvents(model: string, reply: string): OpenAI.Responses.ResponseStreamEvent[] {
  const completed = completedResponse(model, reply);
  const inProgress: OpenAI.Responses.Response = {
    ...completed,
    status: "in_progress",
    completed_at: null,
    output: [],
    output_text: "",
  };
  delete inProgress.usage;
  const item = completed.output[0] as OpenAI.Responses.ResponseOutputMessage;
  const part = item.content[0] as OpenAI.Responses.ResponseOutputText;
  return [
    { type: "response.created", sequence_number: 0, response: inProgress },
    { type: "response.in_progress", sequence_number: 1, response: inProgress },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      sequence_number: 3,
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { ...part, text: "" },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 4,
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: reply,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 5,
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      text: reply,
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      sequence_number: 6,
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part,
    },
    { type: "response.output_item.done", sequence_number: 7, output_index: 0, item },
    { type: "response.completed", sequence_number: 8, response: completed },
  ];
}

/** Offline fetch for real OpenAI clients; fixtures contain only synthetic text and identities. */
export function createFakeOpenAITransport(
  options: FakeOpenAITransportOptions = {},
): FakeOpenAITransport {
  const requests: FakeOpenAIRequest[] = [];
  const reply = options.reply ?? "Synthetic reply.";
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ url: request.url, method: request.method, body });
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(path)) {
        throw new Error("unexpected fake OpenAI route");
      }
      const statuses = options.status ?? 200;
      const status =
        typeof statuses === "number"
          ? statuses
          : (statuses[Math.min(requests.length - 1, statuses.length - 1)] ?? 200);
      const headers = {
        "content-type": "application/json",
        "x-request-id": "req_synthetic",
        "retry-after": "0",
      };
      if (status >= 400) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Synthetic provider failure",
              type: status >= 500 ? "server_error" : "invalid_request_error",
              code: null,
              param: null,
            },
          }),
          { status, headers },
        );
      }
      const model = typeof body["model"] === "string" ? body["model"] : "synthetic-model";
      const chat = path.endsWith("/chat/completions");
      if (body["stream"] === true) {
        const events = chat
          ? `${chatChunks(model, reply)
              .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
              .join("")}data: [DONE]\n\n`
          : responseEvents(model, reply)
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join("");
        return new Response(events, {
          status,
          headers: { ...headers, "content-type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify(chat ? chatCompletion(model, reply) : completedResponse(model, reply)),
        { status, headers },
      );
    },
  };
}
