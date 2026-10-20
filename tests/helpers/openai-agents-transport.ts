import { createFakeOpenAITransport, type FakeOpenAIRequest } from "./fake-openai-transport";

export type AgentsTurn =
  | { readonly kind: "text"; readonly reply?: string }
  | { readonly kind: "tool"; readonly name: string; readonly args?: string }
  | { readonly kind: "error"; readonly status: number };

/** Script only synthetic tool identities and results; all provider traffic stays in memory. */
export function createAgentsTransport(turns: readonly AgentsTurn[]) {
  const requests: FakeOpenAIRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.clone().json()) as Record<string, unknown>;
    requests.push({ url: request.url, method: request.method, body });
    const turn = turns[Math.min(requests.length - 1, turns.length - 1)];
    if (turn === undefined) throw new Error("missing synthetic Agents turn");
    const transport = createFakeOpenAITransport({
      ...(turn.kind === "error" ? { status: turn.status } : {}),
      ...(turn.kind === "text" ? { reply: turn.reply } : {}),
    });
    const response = await transport.fetch(request);
    if (turn.kind !== "tool") return response;
    const callId = `call_synthetic_${requests.length}`;
    const args = turn.args ?? "{}";
    const chat = new URL(request.url).pathname.endsWith("/chat/completions");
    if (chat) {
      const toolCall = {
        id: callId,
        type: "function",
        function: { name: turn.name, arguments: args },
      };
      if (body["stream"] !== true) {
        const completion = await response.json();
        completion.choices = [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [toolCall], refusal: null },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ];
        return Response.json(completion);
      }
      const chunks = (await response.text())
        .split("\n\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      chunks[0].choices = [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: [{ ...toolCall, index: 0 }] },
          finish_reason: null,
        },
      ];
      chunks[1].choices = [];
      chunks[2].choices = [{ index: 0, delta: {}, finish_reason: "tool_calls" }];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const item = {
      type: "function_call",
      id: `fc_synthetic_${requests.length}`,
      call_id: callId,
      name: turn.name,
      arguments: args,
      status: "completed",
    };
    if (body["stream"] !== true) {
      const completed = await response.json();
      completed.output = [item];
      completed.output_text = "";
      return Response.json(completed);
    }
    const lines = (await response.text()).split("\n");
    const last = lines.filter((line) => line.startsWith("data: ")).at(-1);
    if (last === undefined) throw new Error("missing synthetic terminal response");
    const completed = { ...JSON.parse(last.slice(6)).response, output: [item], output_text: "" };
    const events = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { ...completed, status: "in_progress", output: [], usage: null },
      },
      { type: "response.output_item.done", sequence_number: 1, output_index: 0, item },
      { type: "response.completed", sequence_number: 2, response: completed },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  return { fetch, requests };
}
