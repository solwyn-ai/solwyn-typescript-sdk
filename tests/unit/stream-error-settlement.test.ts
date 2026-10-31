import { ApiError, GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { noopLogger } from "../../src/index";
import { run } from "../../src/node";
import { OpenAIAdapter } from "../../src/providers/openai";
import { LatencyTracker } from "../../src/routing";
import { FakeControlPlane } from "../../src/testing";

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Pull through the provider failure rather than cancelling the stream.
  }
}

function googleContinuationFailure(failure: "http" | "network", streaming = true) {
  let requests = 0;
  let streamError: unknown;
  const networkError = new TypeError("synthetic connection drop");
  const raw = new GoogleGenAI({
    apiKey: "offline",
    httpOptions: {
      fetch: async () => {
        if (requests++ > 0) {
          if (failure === "network") throw networkError;
          return Response.json(
            { error: { code: 500, message: "synthetic provider failure", status: "INTERNAL" } },
            { status: 500 },
          );
        }
        const response = {
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [] },
              finishReason: "CONTINUATION",
              continuationToken: "synthetic-checkpoint",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 2,
            cachedContentTokenCount: 4,
            toolUsePromptTokenCount: 1,
          },
        };
        return streaming
          ? new Response(`data: ${JSON.stringify(response)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : Response.json(response);
      },
    },
  });
  // Observe the native generator's error identity without replacing its continuation logic.
  const generate = raw.models.generateContentStream.bind(raw.models);
  vi.spyOn(raw.models, "generateContentStream").mockImplementation(async (params) => {
    const source = await generate(params);
    return (async function* () {
      try {
        yield* source;
      } catch (error) {
        streamError = error;
        throw error;
      }
    })();
  });
  return {
    raw,
    get requests() {
      return requests;
    },
    get streamError() {
      return streamError;
    },
  };
}

const googleParams = {
  model: "gemini-test",
  contents: [{ role: "user", parts: [] }],
  config: { maxOutputTokens: 10 },
};

const observedGoogleUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cached_input_tokens: 4,
  reasoning_tokens: 2,
  tool_use_input_tokens: 1,
};

describe("provider usage observed before a stream error", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "http",
    "network",
  ] as const)("settles Google continuation usage when the next hop has a %s error", async (failure) => {
    const plane = new FakeControlPlane({ mode: "alert_only" });
    const fixture = googleContinuationFailure(failure);
    const breakerFailure = vi.spyOn(CircuitBreaker.prototype, "recordFailure");
    const latencySample = vi.spyOn(LatencyTracker.prototype, "recordLatency");
    const client = plane.wrap(fixture.raw, {
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
    });
    let caught: unknown;
    try {
      caught = await consume(await client.models.generateContentStream(googleParams)).catch(
        (error: unknown) => error,
      );
    } finally {
      await client.close();
    }
    expect(caught).toBeInstanceOf(failure === "http" ? ApiError : Error);
    expect(caught).toBe(fixture.streamError);
    if (failure === "http") expect(caught).toMatchObject({ status: 500 });
    if (failure === "http") {
      expect(fixture.requests).toBe(2);
    } else {
      // Require the original hop, continuation, and a reconnect without pinning native retry counts.
      expect(fixture.requests).toBeGreaterThan(2);
    }
    expect(breakerFailure).toHaveBeenCalledTimes(1);
    expect(latencySample).not.toHaveBeenCalled();
    expect(plane.checks).toHaveLength(1);
    expect(plane.confirms).toHaveLength(1);
    expect(plane.confirms[0]).toMatchObject({ token_details: observedGoogleUsage });
    expect(plane.confirms[0]?.token_details.is_estimated).toBe(false);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: 10,
      output_tokens: 5,
      token_details: observedGoogleUsage,
      possibly_succeeded: true,
      call_id: plane.confirms[0]?.call_id,
    });
    expect(plane.ingested[0]?.failover_error_class).toBeUndefined();
  });

  it("settles observed usage for a tagged run-scoped stream through a per-call check", async () => {
    const plane = new FakeControlPlane({ mode: "alert_only" });
    const fixture = googleContinuationFailure("http");
    const tags = { test_case: "stream_error" };
    const client = plane.wrap(fixture.raw, {
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
    });
    try {
      await run("tagged-stream-error", { tags }, async () => {
        await expect(
          consume(await client.models.generateContentStream(googleParams)),
        ).rejects.toBeInstanceOf(ApiError);
      });
    } finally {
      await client.close();
    }
    expect(plane.leaseGrants).toHaveLength(0);
    expect(plane.leaseSurrenders).toHaveLength(0);
    expect(plane.checks).toHaveLength(1);
    expect(plane.checks[0]?.tags).toEqual(tags);
    expect(plane.checks[0]?.agent_run_id).toEqual(expect.any(String));
    expect(plane.confirms).toHaveLength(1);
    expect(plane.confirms[0]).toMatchObject({
      reservation_id: expect.any(String),
      token_details: observedGoogleUsage,
    });
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: 10,
      output_tokens: 5,
      token_details: observedGoogleUsage,
      possibly_succeeded: true,
      call_id: plane.confirms[0]?.call_id,
      agent_run_id: plane.checks[0]?.agent_run_id,
      tags,
    });
  });

  it("reports observed usage without confirmation when admitted locally during a budget outage", async () => {
    const plane = new FakeControlPlane();
    plane.outage({ path: "/api/v1/budgets/check" });
    const fixture = googleContinuationFailure("http");
    const client = plane.wrap(fixture.raw, {
      failOpen: true,
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
      logger: noopLogger,
    });
    try {
      await expect(
        consume(await client.models.generateContentStream(googleParams)),
      ).rejects.toBeInstanceOf(ApiError);
    } finally {
      await client.close();
    }
    expect(plane.checks).toHaveLength(0);
    expect(plane.leaseGrants).toHaveLength(0);
    expect(plane.confirms).toHaveLength(0);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: 10,
      output_tokens: 5,
      token_details: observedGoogleUsage,
      possibly_succeeded: true,
    });
    expect(plane.ingested[0]?.token_details?.is_estimated).toBe(false);
  });

  it("keeps Google lease-funded errors at zero usage and releases the claim", async () => {
    const plane = new FakeControlPlane({
      grantedTokens: 20,
      finalGrant: true,
      mode: "alert_only",
      postureMode: "alert_only",
    });
    const fixture = googleContinuationFailure("http");
    const client = plane.wrap(fixture.raw, {
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
    });
    try {
      await run("stream-error-lease", async () => {
        await expect(
          consume(await client.models.generateContentStream(googleParams)),
        ).rejects.toBeInstanceOf(ApiError);
        expect(plane.leaseGrants).toHaveLength(1);
        expect(plane.checks).toHaveLength(0);
        // Releasing the first ten-token claim preserves the grant for the next admission.
        await expect(client.models.generateContentStream(googleParams)).rejects.toBeInstanceOf(
          ApiError,
        );
        expect(plane.checks).toHaveLength(0);
      });
    } finally {
      await client.close();
    }
    // Both claims were returned: an unreleased claim would leave the grant short and renew.
    expect(plane.leaseRenewals).toHaveLength(0);
    expect(plane.confirms).toHaveLength(0);
    expect(plane.ingested).toHaveLength(2);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: 0,
      output_tokens: 0,
      possibly_succeeded: true,
    });
    expect(plane.ingested[0]?.token_details).toBeUndefined();
    expect(plane.ingested[0]?.failover_error_class).toBeUndefined();
    expect(plane.leaseSurrenders).toHaveLength(1);
    expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(0);
  });

  it("keeps a dropped OpenAI stream unconfirmed before include_usage arrives", async () => {
    const plane = new FakeControlPlane();
    const failure = new Error("synthetic stream failure");
    const raw = {
      chat: {
        completions: {
          create: async function* (_params: Record<string, unknown>) {
            yield { choices: [{ delta: { content: "synthetic output" } }] };
            throw failure;
          },
        },
      },
    };
    const client = plane.wrap(raw, { breakerReportingEnabled: false });
    try {
      await expect(
        consume(
          await client.chat.completions.create({ model: "gpt-test", messages: [], stream: true }),
        ),
      ).rejects.toBe(failure);
    } finally {
      await client.close();
    }
    expect(plane.confirms).toHaveLength(0);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: 0,
      output_tokens: 0,
      possibly_succeeded: true,
    });
    expect(plane.ingested[0]?.token_details).toBeUndefined();
  });

  it.each([
    { chunk: false, leased: false },
    { chunk: true, leased: false },
    { chunk: false, leased: true },
    { chunk: true, leased: true },
  ])("does not settle compatible fallback estimates (chunk=$chunk, lease=$leased)", async ({
    chunk,
    leased,
  }) => {
    const plane = new FakeControlPlane();
    const failure = new Error("synthetic compatible stream failure");
    const client = plane.wrap(
      {
        baseURL: "https://api.deepseek.com/v1",
        chat: {
          completions: {
            create: async function* (_params: Record<string, unknown>) {
              if (chunk) yield { choices: [{ delta: { content: "synthetic output" } }] };
              throw failure;
            },
          },
        },
      },
      { breakerReportingEnabled: false, logger: noopLogger },
    );
    try {
      const call = async () => {
        await expect(
          consume(
            await client.chat.completions.create({
              model: "deepseek-chat",
              messages: [{ role: "user", content: "synthetic input" }],
              max_tokens: 20,
              stream: true,
            }),
          ),
        ).rejects.toBe(failure);
      };
      if (leased) await run("compatible-stream-error", call);
      else await call();
    } finally {
      await client.close();
    }
    expect(plane.confirms).toHaveLength(0);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: 0,
      output_tokens: 0,
      possibly_succeeded: true,
    });
    expect(plane.leaseSurrenders).toHaveLength(leased ? 1 : 0);
    if (leased) expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(0);
  });

  it.each([
    false,
    true,
  ])("preserves the provider error when finalization throws (lease=%s)", async (leased) => {
    const finalize = vi.fn(() => {
      throw new Error("synthetic usage extraction failure");
    });
    vi.spyOn(OpenAIAdapter.prototype, "createStreamAccumulator").mockReturnValue({
      observe() {},
      finalize,
      getServiceTier: () => null,
    });
    const plane = new FakeControlPlane();
    const failure = new Error("synthetic provider failure");
    const client = plane.wrap(
      {
        chat: {
          completions: {
            create: async function* (_params: Record<string, unknown>) {
              yield {};
              throw failure;
            },
          },
        },
      },
      { breakerReportingEnabled: false, logger: noopLogger },
    );
    try {
      const call = async () => {
        await expect(
          consume(
            await client.chat.completions.create({
              model: "gpt-test",
              messages: [{ role: "user", content: "synthetic input" }],
              max_tokens: 20,
              stream: true,
            }),
          ),
        ).rejects.toBe(failure);
      };
      if (leased) await run("unreadable-stream-usage", call);
      else await call();
    } finally {
      await client.close();
    }
    expect(plane.confirms).toHaveLength(0);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({ status: "error", input_tokens: 0, output_tokens: 0 });
    expect(finalize).toHaveBeenCalledTimes(leased ? 0 : 1);
    if (leased) expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(0);
  });

  it.each([
    false,
    true,
  ])("settles partial Anthropic input only without lease funding (lease=%s)", async (leased) => {
    const plane = new FakeControlPlane();
    const failure = new Error("synthetic Anthropic stream failure");
    const client = plane.wrap(
      {
        messages: {
          create: async function* (_params: Record<string, unknown>) {
            yield { type: "message_start", message: { usage: { input_tokens: 12 } } };
            throw failure;
          },
        },
      },
      { breakerReportingEnabled: false, logger: noopLogger },
    );
    try {
      const call = async () => {
        await expect(
          consume(
            await client.messages.create({
              model: "claude-test",
              messages: [],
              max_tokens: 20,
              stream: true,
            }),
          ),
        ).rejects.toBe(failure);
      };
      if (leased) await run("partial-stream-error", call);
      else await call();
    } finally {
      await client.close();
    }
    expect(plane.confirms).toHaveLength(leased ? 0 : 1);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: leased ? 0 : 12,
      output_tokens: 0,
      possibly_succeeded: true,
    });
    expect(plane.ingested[0]?.failover_error_class).toBeUndefined();
    if (leased) {
      expect(plane.ingested[0]?.token_details).toBeUndefined();
      expect(plane.leaseSurrenders).toHaveLength(1);
      expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(0);
    } else {
      expect(plane.checks).toHaveLength(1);
      expect(plane.confirms[0]?.token_details).toMatchObject({
        input_tokens: 12,
        output_tokens: 0,
        is_estimated: true,
      });
      expect(plane.ingested[0]?.token_details).toMatchObject({
        input_tokens: 12,
        output_tokens: 0,
        is_estimated: true,
      });
    }
  });

  it("cannot settle earlier buffered Google continuation usage when a later hop fails", async () => {
    const plane = new FakeControlPlane({ mode: "alert_only" });
    const fixture = googleContinuationFailure("http", false);
    const client = plane.wrap(fixture.raw, {
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
    });
    try {
      await expect(client.models.generateContent(googleParams)).rejects.toBeInstanceOf(ApiError);
    } finally {
      await client.close();
    }
    expect(fixture.requests).toBe(2);
    expect(plane.checks).toHaveLength(1);
    expect(plane.confirms).toHaveLength(0);
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "error",
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(plane.ingested[0]?.token_details).toBeUndefined();
  });
});
