import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { noopLogger, RunStoppedError, Solwyn, UntranslatableRequestError } from "../../src/index";
import { currentRun, run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import type { StreamWrapper } from "../../src/stream";
import { FakeControlPlane } from "../../src/testing";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetRunControlForTest();
});

type Conversion = "iteration" | "tee" | "readable";

/** Inspect synthetic data only here; assertions expose booleans/counts. */
async function consume(stream: StreamWrapper, mode: Conversion, marker: string): Promise<boolean> {
  let preserved = false;
  if (mode === "readable") {
    const reader = stream.toReadableStream().getReader();
    for (;;) {
      const item = await reader.read();
      if (item.done) return preserved;
      preserved ||= new TextDecoder().decode(item.value).includes(marker);
    }
  }
  const branches = mode === "tee" ? stream.tee() : [stream];
  let firstFailure: { error: unknown } | undefined;
  for (const branch of branches) {
    try {
      for await (const item of branch) preserved ||= JSON.stringify(item).includes(marker);
    } catch (error) {
      if (firstFailure === undefined) firstFailure = { error };
      else expect(error).toBe(firstFailure.error);
    }
  }
  if (firstFailure !== undefined) throw firstFailure.error;
  return preserved;
}

describe("post-remediation native converted HALF_OPEN accounting", () => {
  for (const mode of ["tee", "readable"] as const) {
    it.each([
      "stop",
      "error",
      "provider translation error",
    ] as const)(`${mode} retains actual cross-dialect admission ownership on %s`, async (outcome) => {
      const plane = new FakeControlPlane({ grantedTokens: 2048, finalGrant: true });
      const failures = vi.spyOn(CircuitBreaker.prototype, "recordFailure");
      const successes = vi.spyOn(CircuitBreaker.prototype, "recordSuccess");
      let fallbackCalls = 0;
      let signal: AbortSignal | null | undefined;
      const marker = crypto.randomUUID();
      const failure =
        outcome === "provider translation error"
          ? new UntranslatableRequestError({
              source: "anthropic",
              target: "openai",
              feature: "cross_provider_tool_stream",
            })
          : new TypeError();
      const fallback = new Anthropic({
        apiKey: "offline",
        maxRetries: 0,
        fetch: async (_url, init) => {
          fallbackCalls++;
          if (fallbackCalls === 1) return new Response(null, { status: 429 });
          signal = init?.signal;
          const items = [
            { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 0 } } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: marker } },
            { type: "message_delta", delta: {}, usage: { output_tokens: 20 } },
          ];
          let offset = 0;
          const body = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (offset === 2 && outcome !== "stop") {
                  controller.error(failure);
                  return;
                }
                const item = items[offset++];
                if (item === undefined) {
                  controller.close();
                  return;
                }
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`,
                  ),
                );
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
      });
      const client = new Solwyn(
        new OpenAI({
          apiKey: "offline",
          maxRetries: 0,
          fetch: async () => new Response(null, { status: 429 }),
        }),
        {
          apiKey: plane.apiKey,
          apiUrl: plane.apiUrl,
          fetch: plane.fetch,
          logger: noopLogger,
          fallback: [[fallback, "claude-sonnet-4-5"]],
          breakerReportingEnabled: false,
          reportUntrackedSurfaces: false,
          circuitBreakerFailureThreshold: 1,
          circuitBreakerRecoveryTimeout: 0,
          circuitBreakerSuccessThreshold: 1,
          circuitBreakerRecoveryTimeoutJitter: 0,
        },
      );
      try {
        await run(`composition-${mode}-${outcome}`, async () => {
          const request = () =>
            client.chat.completions.create({
              model: "gpt-4o",
              messages: [],
              max_tokens: 128,
              stream: true,
            });
          await expect(request()).rejects.toBeInstanceOf(Error);
          const fallbackBreaker = failures.mock.contexts.at(-1);
          if (!(fallbackBreaker instanceof CircuitBreaker))
            throw new Error("Expected failed native admission");
          const stream = (await request()) as unknown as StreamWrapper;
          expect(fallbackBreaker.getState().state).toBe("half_open");
          expect(fallbackBreaker.admit().allowed).toBe(false);
          const branches = mode === "tee" ? stream.tee() : undefined;
          const reader = mode === "readable" ? stream.toReadableStream().getReader() : undefined;
          const first = reader ? await reader.read() : await branches?.[0].next();
          expect(first?.done).toBe(false);
          expect(
            reader
              ? new TextDecoder().decode(first?.value as Uint8Array).includes(marker)
              : JSON.stringify(first?.value).includes(marker),
          ).toBe(true);
          if (outcome === "stop") {
            markTerminated(currentRun()?.agentRunId ?? "", {
              source: "server",
              reason: "run_stopped",
            });
          }
          const next = reader ? reader.read() : branches?.[0].next();
          if (outcome === "stop") await expect(next).rejects.toBeInstanceOf(RunStoppedError);
          else await expect(next).rejects.toBe(failure);
          if (branches) {
            expect((await branches[1].next()).done).toBe(false);
            if (outcome === "stop")
              await expect(branches[1].next()).rejects.toBeInstanceOf(RunStoppedError);
            else await expect(branches[1].next()).rejects.toBe(failure);
          }
          await stream.close();
          expect(fallbackBreaker.getState().state).toBe(outcome === "stop" ? "closed" : "open");
          expect(failures.mock.contexts.filter((item) => item === fallbackBreaker)).toHaveLength(
            outcome === "stop" ? 1 : 2,
          );
          expect(successes.mock.contexts.filter((item) => item === fallbackBreaker)).toHaveLength(
            outcome === "stop" ? 1 : 0,
          );
          expect(fallbackBreaker.admit().allowed).toBe(true);
        });
      } finally {
        await client.close();
      }
      expect(fallbackCalls).toBe(2);
      expect(plane.confirms).toHaveLength(outcome === "stop" ? 1 : 0);
      expect(plane.leaseSurrenders).toHaveLength(1);
      expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(outcome === "stop" ? 128 : 0);
      if (outcome === "stop") expect(signal?.aborted).toBe(true);
    });
  }
});

describe("PR-A1: measured paid stream translation failure", () => {
  for (const lease of [false, true]) {
    for (const malformed of [false, true]) {
      for (const mode of ["iteration", "tee", "readable"] as const) {
        it.each([
          "delivered",
          "rejected",
          "enqueue failure",
          "construction failure",
        ] as const)(`retains measured paid usage (lease=${lease}, malformed=${malformed}, mode=${mode}, reporter=%s)`, async (reporting) => {
          const plane = new FakeControlPlane({ grantedTokens: 512, finalGrant: true });
          const attemptedConfirms: BudgetConfirmRequest[] = [];
          const attemptedEvents: MetadataEvent[] = [];
          const marker = crypto.randomUUID();
          let targetCalls = 0;
          let sourceCalls = 0;
          vi.stubGlobal("fetch", async () => {
            targetCalls++;
            const result = {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      malformed
                        ? { functionCall: { name: "structural_tool", args: {} } }
                        : { text: marker },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20 },
            };
            return new Response(`data: ${JSON.stringify(result)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            });
          });
          const client = new Solwyn(
            new OpenAI({
              apiKey: "offline",
              maxRetries: 0,
              fetch: async () => {
                sourceCalls++;
                return new Response(null, { status: 429 });
              },
            }),
            {
              apiKey: plane.apiKey,
              apiUrl: plane.apiUrl,
              fetch: async (url, init) => {
                if (url.endsWith("/budgets/confirm")) {
                  attemptedConfirms.push(JSON.parse(String(init?.body)) as BudgetConfirmRequest);
                  if (reporting === "rejected") return new Response(null, { status: 422 });
                }
                if (url.endsWith("/metadata/ingest"))
                  attemptedEvents.push(...(JSON.parse(String(init?.body)) as MetadataEvent[]));
                return plane.fetch(url, init);
              },
              logger: noopLogger,
              leaseEnabled: lease,
              reporterMaxSendAttempts: 1,
              reportUntrackedSurfaces: false,
              breakerReportingEnabled: false,
              fallback: [[new GoogleGenAI({ apiKey: "offline" }), "gemini-2.5-flash"]],
            },
          );
          if (reporting === "enqueue failure")
            vi.spyOn(MetadataReporter.prototype, "reportSettlement").mockImplementation(() => {
              throw new Error();
            });
          if (reporting === "construction failure")
            vi.spyOn(BudgetEnforcer.prototype, "buildConfirmRequest").mockImplementation(() => {
              throw new Error();
            });
          let reservationFloor = 0;
          const check = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
          try {
            await run("paid-stream-normalization", async () => {
              const stream = (await client.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: marker }],
                max_tokens: 128,
                stream: true,
              })) as unknown as StreamWrapper;
              const admission = check.mock.calls[0]?.[0];
              reservationFloor =
                (admission?.estimatedInputTokens ?? 0) + (admission?.estimatedOutputBound ?? 0);
              if (malformed)
                await expect(consume(stream, mode, marker)).rejects.toBeInstanceOf(
                  UntranslatableRequestError,
                );
              else expect(await consume(stream, mode, marker)).toBe(true);
              await stream.close();
              await stream.return();
              await stream[Symbol.asyncDispose]();
            });
          } finally {
            await client.close();
            await client.close();
          }
          expect(sourceCalls).toBe(1);
          expect(targetCalls).toBe(1);
          const confirmed = reporting === "delivered" || reporting === "rejected";
          expect(attemptedConfirms).toHaveLength(confirmed ? 1 : 0);
          expect(plane.confirms).toHaveLength(reporting === "delivered" ? 1 : 0);
          if (confirmed) {
            expect(attemptedConfirms[0]).toMatchObject({
              provider: "google",
              token_details: { input_tokens: 30, output_tokens: 20 },
              is_provider_fallback: true,
            });
            expect(Boolean(attemptedConfirms[0]?.lease_id)).toBe(lease);
            expect(Boolean(attemptedConfirms[0]?.reservation_id)).toBe(!lease);
          }
          const paid = plane.ingested.filter((event) => event.provider === "google");
          expect(attemptedEvents.filter((event) => event.provider === "google")).toHaveLength(1);
          expect(paid).toHaveLength(1);
          expect(paid[0]).toMatchObject({
            status: malformed ? "error" : "success",
            input_tokens: 30,
            output_tokens: 20,
            token_details: { input_tokens: 30, output_tokens: 20, is_estimated: false },
            attempt_index: 1,
            is_provider_fallback: true,
          });
          expect(paid[0]?.failover_error_class ?? null).toBe(
            malformed ? "UntranslatableRequestError" : null,
          );
          if (confirmed) expect(paid[0]?.call_id).toBe(attemptedConfirms[0]?.call_id);
          expect(plane.leaseSurrenders).toHaveLength(lease ? 1 : 0);
          if (lease)
            expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(
              reporting === "construction failure" ? reservationFloor : 50,
            );
          expect(
            JSON.stringify([attemptedConfirms, attemptedEvents, plane.leaseSurrenders]).includes(
              marker,
            ),
          ).toBe(false);
        });
      }
    }
  }
});

describe("PR-A1: native translated error authority", () => {
  for (const mode of ["iteration", "tee", "readable"] as const) {
    it.each([
      "translation",
      "stop",
    ] as const)(`keeps HALF_OPEN ${mode} accounting and stop precedence for %s`, async (outcome) => {
      const plane = new FakeControlPlane({ grantedTokens: 512, finalGrant: true });
      const failures = vi.spyOn(CircuitBreaker.prototype, "recordFailure");
      const successes = vi.spyOn(CircuitBreaker.prototype, "recordSuccess");
      const releases = vi.spyOn(CircuitBreaker.prototype, "releaseProbe");
      const admissions = vi.spyOn(CircuitBreaker.prototype, "admit");
      const check = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
      const marker = crypto.randomUUID();
      let targetCalls = 0;
      vi.stubGlobal("fetch", async () => {
        targetCalls++;
        if (targetCalls === 1) return Response.json({ error: { code: 429 } }, { status: 429 });
        const result = {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "structural_tool", args: {} } }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20 },
        };
        return new Response(`data: ${JSON.stringify(result)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const client = new Solwyn(
        new OpenAI({
          apiKey: "offline",
          maxRetries: 0,
          fetch: async () => new Response(null, { status: 429 }),
        }),
        {
          apiKey: plane.apiKey,
          apiUrl: plane.apiUrl,
          fetch: plane.fetch,
          logger: noopLogger,
          reportUntrackedSurfaces: false,
          breakerReportingEnabled: false,
          circuitBreakerFailureThreshold: 1,
          circuitBreakerRecoveryTimeout: 0,
          circuitBreakerSuccessThreshold: 1,
          circuitBreakerRecoveryTimeoutJitter: 0,
          fallback: [[new GoogleGenAI({ apiKey: "offline" }), "gemini-2.5-flash"]],
        },
      );
      let reservationFloor = 0;
      try {
        await run("paid-stream-authority", async () => {
          const request = () =>
            client.chat.completions.create({
              model: "gpt-4o",
              messages: [{ role: "user", content: marker }],
              max_tokens: 128,
              stream: true,
            });
          await expect(request()).rejects.toBeInstanceOf(Error);
          const targetBreaker = failures.mock.contexts.at(-1);
          if (!(targetBreaker instanceof CircuitBreaker))
            throw new Error("Expected failed native target");
          const stream = (await request()) as unknown as StreamWrapper;
          const targetAdmission = admissions.mock.results.findLast(
            (result, index) =>
              admissions.mock.contexts[index] === targetBreaker &&
              result.type === "return" &&
              result.value.ownsProbe,
          );
          expect(targetAdmission?.type).toBe("return");
          expect(targetBreaker.getState().state).toBe("half_open");
          const requestAdmission = check.mock.calls.at(-1)?.[0];
          reservationFloor =
            (requestAdmission?.estimatedInputTokens ?? 0) +
            (requestAdmission?.estimatedOutputBound ?? 0);
          if (outcome === "stop")
            markTerminated(currentRun()?.agentRunId ?? "", {
              source: "server",
              reason: "run_stopped",
            });
          await expect(consume(stream, mode, marker)).rejects.toBeInstanceOf(
            outcome === "stop" ? RunStoppedError : UntranslatableRequestError,
          );
          await stream.close();
          await stream.close();
          expect(failures.mock.contexts.filter((item) => item === targetBreaker)).toHaveLength(1);
          expect(successes.mock.contexts.filter((item) => item === targetBreaker)).toHaveLength(
            outcome === "stop" ? 1 : 0,
          );
          expect(targetBreaker.getState().state).toBe(outcome === "stop" ? "closed" : "half_open");
          if (outcome === "translation")
            expect(
              releases.mock.calls.some(
                (args, index) =>
                  releases.mock.contexts[index] === targetBreaker &&
                  args[0] === targetAdmission?.value,
              ),
            ).toBe(true);
          const nextAdmission = targetBreaker.admit();
          expect(nextAdmission.allowed).toBe(true);
          targetBreaker.releaseProbe(nextAdmission);
        });
      } finally {
        await client.close();
      }
      expect(targetCalls).toBe(2);
      expect(plane.confirms).toHaveLength(1);
      expect(plane.confirms[0]?.token_details).toMatchObject({
        input_tokens: outcome === "stop" ? 0 : 30,
        output_tokens: outcome === "stop" ? 0 : 20,
      });
      expect(plane.leaseSurrenders).toHaveLength(1);
      expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(
        outcome === "stop" ? reservationFloor : 50,
      );
    });
  }
});
