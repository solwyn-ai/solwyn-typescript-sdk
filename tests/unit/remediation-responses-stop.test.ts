import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStoppedError, Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import type { FetchLike } from "../../src/transport";

afterEach(() => {
  resetRunControlForTest();
  vi.restoreAllMocks();
});

describe("remediation 10: native Responses subscription stop boundaries", () => {
  it.each([
    false,
    true,
  ])("suppresses stopped events and cleans native listeners (first boundary: %s)", async (firstBoundary) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const encoder = new TextEncoder();
    const push = (event: unknown) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const response = {
      id: "resp_remediation",
      object: "response",
      status: "in_progress",
      output: [],
      usage: null,
    };
    const confirms: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith("/budgets/check"))
        return Response.json({
          allowed: true,
          remaining_budget: 100,
          reservation_id: "reservation-remediation",
          mode: "hard_deny",
          budget_limit: 100,
          current_usage: 0,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        });
      if (url.endsWith("/budgets/confirm")) {
        confirms.push(JSON.parse(init?.body as string));
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/metadata/ingest")) {
        const batch = JSON.parse(init?.body as string) as Record<string, unknown>[];
        events.push(...batch);
        return Response.json({ ingested: batch.length, rejected: [] }, { status: 202 });
      }
      if (url.includes("/breaker-reports")) return new Response(null, { status: 204 });
      throw new Error("unexpected offline control route");
    };
    const raw = new OpenAI({
      apiKey: "offline",
      maxRetries: 0,
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    const original = raw.responses.stream.bind(raw.responses);
    let native: ReturnType<typeof original> | undefined;
    const active = new Map<string, Set<unknown>>();
    vi.spyOn(raw.responses, "stream").mockImplementation((...args) => {
      native = original(...args);
      const on = native.on.bind(native);
      const off = native.off.bind(native);
      vi.spyOn(native, "on").mockImplementation((event, listener) => {
        const listeners = active.get(event) ?? new Set();
        listeners.add(listener);
        active.set(event, listeners);
        return on(event, listener);
      });
      vi.spyOn(native, "off").mockImplementation((event, listener) => {
        active.get(event)?.delete(listener);
        return off(event, listener);
      });
      return native;
    });
    const sdk = new Solwyn(raw, {
      apiKey: `sk_proj_${"0".repeat(64)}`,
      fetch,
      leaseEnabled: false,
      velocityMode: "off",
      reportUntrackedSurfaces: false,
      logger: noopLogger,
    });
    try {
      await run("responses-remediation", async () => {
        const helper = sdk.responses.stream({ model: "gpt-4o", input: [] });
        const generic = vi.fn();
        const completed = vi.fn();
        const once = vi.fn();
        const removed = vi.fn();
        const errors: unknown[] = [];
        helper
          .on("event", generic)
          .on("response.completed", completed)
          .once("response.completed", once);
        helper.on("response.completed", removed).off("response.completed", removed);
        helper.on("error", (error) => errors.push(error));
        const waiting = helper.emitted("response.completed").then(
          () => null,
          (error: unknown) => error,
        );
        if (!firstBoundary) {
          const created = helper.emitted("response.created");
          push({ type: "response.created", sequence_number: 0, response });
          await created;
          expect(generic).toHaveBeenCalledTimes(1);
        } else {
          const connect = helper.emitted("connect");
          await connect;
        }
        markTerminated(currentRun()?.agentRunId ?? "", { source: "server", reason: "run_stopped" });
        if (firstBoundary) push({ type: "response.created", sequence_number: 0, response });
        push({
          type: "response.completed",
          sequence_number: 1,
          response: {
            ...response,
            status: "completed",
            usage: {
              input_tokens: 18,
              output_tokens: 7,
              total_tokens: 25,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        });
        controller.close();
        const waitError = await waiting;
        const doneError = await helper.done().then(
          () => null,
          (error: unknown) => error,
        );
        const finalError = await helper.finalResponse().then(
          () => null,
          (error: unknown) => error,
        );
        expect(waitError).toBeInstanceOf(RunStoppedError);
        expect(doneError).toBe(waitError);
        expect(finalError).toBe(waitError);
        await expect(helper.emitted("response.completed")).rejects.toBe(waitError);
        expect(errors).toEqual([waitError]);
        expect(generic).toHaveBeenCalledTimes(firstBoundary ? 0 : 1);
        expect(completed).not.toHaveBeenCalled();
        expect(once).not.toHaveBeenCalled();
        expect(removed).not.toHaveBeenCalled();
      });
      await sdk.close();
      expect(confirms).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "success", input_tokens: 0, output_tokens: 0 });
      expect([...active.values()].reduce((count, listeners) => count + listeners.size, 0)).toBe(0);
      expect(native?.controller.signal.aborted).toBe(true);
    } finally {
      await sdk.close();
    }
  });
});
