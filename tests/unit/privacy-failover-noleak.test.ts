/**
 * End-to-end privacy backstop on the translating cross-provider failover path in the core
 * `Solwyn` client, covering buffered and streaming calls with mocked `fetch` and web-stream
 * async iteration.
 *
 * The scenario drives a real cross-dialect (OpenAI → Anthropic) failover THROUGH the real
 * adapter registry and the real client dispatch/budget/reporter path. A unique SENTINEL is
 * embedded in BOTH the outbound request content (system + user message) AND the fallback
 * Anthropic provider's returned response text / streamed chunk text. The cross-provider
 * translation step therefore demonstrably runs on the sentinel-bearing content (asserted:
 * the sentinel reaches the translated Anthropic call, and the normalized response / drained
 * stream the caller sees still carries it). We capture EVERY JSON body POSTed to the Solwyn
 * Cloud API (budget check + confirm + metadata ingest — ≥3 payloads) and assert the sentinel
 * appears in NONE of them, and in no injected-logger line — proving the translating
 * core-client path is content-blind.
 *
 * The primary is made to fail loudly with a 429 so the cross-dialect Anthropic fallback
 * actually serves: the primary never serves the call, Anthropic does, and translation plus
 * normalization run end to end.
 *
 * Fully offline; mocked `fetch`, fake provider callables (no provider SDK imported).
 */

import { describe, expect, it, vi } from "vitest";
import { Solwyn } from "../../src/index";
import type { Logger } from "../../src/logging";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const SENTINEL = "SUPER_SECRET_PROMPT_a1b2c3";

/** A minimal OpenAI-dialect client (native `openai` NAME). */
function openaiClient(create: (kwargs: Record<string, unknown>) => unknown) {
  return { chat: { completions: { create: vi.fn(create) } } };
}

/** An error carrying an HTTP status the classifier reads (`.status`, matching the npm SDKs). */
function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

interface RawCapture {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  /** Raw `{ url, body }` of every POST to the Cloud API (body kept as its literal JSON string). */
  bodies: Array<{ url: string; body: string }>;
}

/**
 * A Cloud-API `fetch` that ALLOWS with a reservation and records the RAW string body of every
 * request (never re-serialized — so the assertion sees exactly what went on the wire). Stands
 * in for the budget check, the confirm, AND the metadata ingest.
 */
function makeRawCapture(): RawCapture {
  const bodies: Array<{ url: string; body: string }> = [];
  const impl: FetchLike = async (url, init) => {
    if (typeof init?.body === "string") {
      bodies.push({ url, body: init.body });
    }
    if (url.includes("/api/v1/budgets/check")) {
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: "res-1",
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      return new Response(null, { status: 204 });
    }
    // Metadata ingest.
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), bodies };
}

/** A logger capturing every line (message + stringified args) across all levels. */
function capturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string, ...args: unknown[]): void => {
    lines.push([message, ...args.map((a) => String(a))].join(" "));
  };
  return { lines, debug: push, info: push, warn: push, error: push };
}

/** Assert ≥3 Cloud payloads spanning check + confirm + ingest, none carrying the sentinel. */
function assertNoLeak(bodies: Array<{ url: string; body: string }>, lines: string[]): void {
  // At least the budget check + confirm + metadata ingest were captured…
  expect(bodies.length).toBeGreaterThanOrEqual(3);
  expect(bodies.some((b) => b.url.includes("/api/v1/budgets/check"))).toBe(true);
  expect(bodies.some((b) => b.url.includes("/api/v1/budgets/confirm"))).toBe(true);
  expect(bodies.some((b) => b.url.includes("/api/v1/metadata/ingest"))).toBe(true);
  // …and NOT ONE Cloud API payload carries any prompt or response content.
  for (const { url, body } of bodies) {
    expect(body, `PRIVACY BREACH: sentinel reached the Cloud API at ${url}`).not.toContain(
      SENTINEL,
    );
  }
  // Nor does any injected-logger line.
  for (const line of lines) {
    expect(line, "PRIVACY BREACH: sentinel reached an injected logger line").not.toContain(
      SENTINEL,
    );
  }
}

describe("privacy backstop — translating cross-provider failover carries no content to the Cloud API", () => {
  it("non-streaming: sentinel in request + cross-dialect response never reaches any Cloud payload (test_failover_solwyn_payloads_carry_no_content)", async () => {
    // OpenAI primary 429s → reactive cross-dialect FAILOVER; the Anthropic fallback SERVES the
    // translated (sentinel-bearing) request and returns a native response whose OUTPUT text also
    // carries the sentinel — proving neither the prompt nor the response reaches the Cloud API.
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    const anthropicResponse = {
      role: "assistant",
      content: [{ type: "text", text: `echo ${SENTINEL}` }],
      stop_reason: "end_turn",
      model: "claude-3-5-sonnet-20241022",
      usage: { input_tokens: 11, output_tokens: 7 },
    };
    const anthropicCreate = vi.fn((_kwargs: Record<string, unknown>) => anthropicResponse);
    const fallback = { messages: { create: anthropicCreate } };
    const { fetchMock, bodies } = makeRawCapture();
    const logger = capturingLogger();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger,
      fallback: [[fallback, "claude-3-5-sonnet-20241022", { max_tokens: 256 }]],
    });

    const result = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: `system ${SENTINEL}` },
        { role: "user", content: `user prompt ${SENTINEL}` },
      ],
    })) as Record<string, unknown>;
    await solwyn.close();

    // Sanity: the cross-dialect Anthropic hop actually served, translation DID run on the
    // sentinel-bearing content (the translated Anthropic request carries it), and the normalized
    // response handed back to the caller (OpenAI `choices` shape) carries it too.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    const served = anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(served)).toContain(SENTINEL);
    expect(Array.isArray(result["choices"])).toBe(true);
    expect(JSON.stringify(result["choices"])).toContain(SENTINEL);

    assertNoLeak(bodies, logger.lines);
  });

  it("streaming: sentinel in request + every streamed chunk never reaches any Cloud payload (test_failover_streaming_solwyn_payloads_carry_no_content)", async () => {
    // OpenAI primary 429s at establishment → cross-dialect Anthropic STREAM fallback serves; every
    // streamed chunk's text carries the sentinel, so per-chunk translation runs on it and the
    // caller-visible drained stream carries it — yet none of it reaches the Cloud API.
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    async function* anthropicStream(): AsyncGenerator<unknown> {
      yield { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `echo ${SENTINEL}` },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ` again ${SENTINEL}` },
      };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      };
      yield { type: "message_stop" };
    }
    const anthropicCreate = vi.fn(() => anthropicStream());
    const fallback = { messages: { create: anthropicCreate } };
    const { fetchMock, bodies } = makeRawCapture();
    const logger = capturingLogger();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger,
      fallback: [[fallback, "claude-3-5-sonnet-20241022", { max_tokens: 256 }]],
    });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: `system ${SENTINEL}` },
        { role: "user", content: `user prompt ${SENTINEL}` },
      ],
      max_tokens: 100,
      stream: true,
    })) as AsyncIterable<unknown>;

    // Drain the wrapper to completion so on_complete (confirm + settlement metadata) fires.
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Record<string, unknown>);
    }
    await solwyn.close();

    // Sanity: the cross-dialect Anthropic stream served, per-chunk translation ran, and the
    // caller-visible drained stream (OpenAI-dialect chunks) carries the sentinel-bearing text.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    const drained = chunks
      .map((c) => {
        const choice = (c["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
        return (choice?.["delta"] as Record<string, unknown> | undefined)?.["content"];
      })
      .filter((t): t is string => typeof t === "string")
      .join("");
    expect(drained).toContain(SENTINEL);

    assertNoLeak(bodies, logger.lines);
  });
});
