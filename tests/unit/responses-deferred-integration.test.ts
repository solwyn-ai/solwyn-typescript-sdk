import OpenAI from "openai";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SolwynOptions } from "../../src/client";
import { Solwyn } from "../../src/index";
import { currentRun, run } from "../../src/node";
import { __resetAdapterRegistry, __setAdapterLoadersForTesting } from "../../src/providers/index";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

afterEach(() => {
  resetRunControlForTest();
  __resetAdapterRegistry();
  vi.restoreAllMocks();
});

function fixture(baseURL = "https://api.openai.com/v1", options: SolwynOptions = {}) {
  const checks: Record<string, unknown>[] = [];
  const confirms: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const providerRequests: Record<string, unknown>[] = [];
  const surrenders: Record<string, unknown>[] = [];
  const breakerReports: Record<string, unknown>[] = [];
  const response = {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 18,
      output_tokens: 7,
      total_tokens: 25,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
    service_tier: "flex",
  };
  const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
    providerRequests.push(JSON.parse(init?.body as string));
    const chunks = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { ...response, status: "in_progress" },
      },
      { type: "response.completed", sequence_number: 1, response },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const controlFetch: FetchLike = async (url, init) => {
    if (url.includes("/breaker-reports")) {
      breakerReports.push(JSON.parse(init?.body as string));
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    if (url.endsWith("/budgets/lease")) {
      return new Response(
        JSON.stringify({
          eligible: true,
          allowed: true,
          lease_id: "lease-deferred",
          generation: 1,
          granted_tokens: 2_000,
          refresh_interval_s: 300,
          lease_length_s: 600,
          headroom_share_tokens: 0,
          posture: { mode: "alert_only", on_unreachable: "fail_open" },
          final_grant: false,
          project_id: `proj_${"0".repeat(24)}`,
          mode: "alert_only",
          budget_limit: 1_000,
          current_usage: 100,
          remaining_budget: 900,
        }),
      );
    }
    if (url.endsWith("/budgets/lease/surrender")) {
      surrenders.push(body);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/budgets/check")) {
      checks.push(body);
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 100,
          reservation_id: "reservation-stream",
          mode: "alert_only",
          budget_limit: 100,
          current_usage: 0,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
      );
    }
    if (url.includes("/budgets/confirm")) {
      confirms.push(body);
      return new Response(null, { status: 204 });
    }
    events.push(...(body as unknown as Record<string, unknown>[]));
    return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
  };
  const provider = new OpenAI({ apiKey: "offline", baseURL, fetch: providerFetch });
  const streamCall = vi.spyOn(provider.responses, "stream");
  const solwyn = new Solwyn(provider, {
    apiKey: API_KEY,
    model: "gpt-4o",
    fetch: controlFetch,
    leaseEnabled: false,
    onUnmetered: "raise",
    tags: { configured: "yes" },
    defaultParams: { max_output_tokens: 30, stream_options: { include_usage: true } },
    ...options,
  });
  return {
    solwyn,
    provider,
    streamCall,
    providerFetch,
    checks,
    confirms,
    events,
    providerRequests,
    surrenders,
    breakerReports,
  };
}

describe("deferred Responses client integration", () => {
  it.each([
    "https://api.openai.com/v1",
    "https://fixture.openai.azure.com/openai/v1",
  ])("%s captures issuance scope/options and meters finalResponse once", async (baseURL) => {
    const f = fixture(baseURL);
    let issuedRunId: string | undefined;
    const params = { input: "12345678", solwyn_tags: { call: "issued" }, max_output_tokens: 12 };
    const options = { headers: { "x-test": "issued" } };
    const helper = await run("issued", { tags: { scope: "issued" } }, () => {
      issuedRunId = currentRun()?.agentRunId;
      return f.solwyn.responses.stream(params, options);
    });
    expect(helper).not.toBeInstanceOf(Promise);
    expect(f.streamCall).not.toHaveBeenCalled();
    expect(f.checks).toHaveLength(0);
    params.max_output_tokens = 99;
    params.solwyn_tags.call = "later";
    options.headers = { "x-test": "later" };
    await run("activated", { tags: { scope: "later" } }, async () => {
      const [a, b] = await Promise.all([
        helper.finalResponse(),
        helper.finalResponse(),
        helper.done(),
      ]);
      expect(a).toBe(b);
    });
    await f.solwyn.close();
    expect(f.streamCall).toHaveBeenCalledTimes(1);
    expect(f.streamCall.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-4o",
      max_output_tokens: 12,
    });
    expect(f.streamCall.mock.calls[0]?.[0]).not.toHaveProperty("stream");
    expect(f.streamCall.mock.calls[0]?.[0]).not.toHaveProperty("stream_options");
    expect(f.streamCall.mock.calls[0]?.[1]?.headers).toEqual({ "x-test": "issued" });
    expect(f.checks).toHaveLength(1);
    expect(f.checks[0]).toMatchObject({
      agent_run_id: issuedRunId,
      tags: { configured: "yes", call: "issued", scope: "issued" },
    });
    expect(f.confirms).toHaveLength(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      status: "success",
      agent_run_id: issuedRunId,
      input_tokens: 18,
      output_tokens: 7,
    });
    expect(f.confirms[0]?.["token_details"]).toMatchObject({
      input_tokens: 18,
      output_tokens: 7,
      cached_input_tokens: 5,
      reasoning_tokens: 3,
    });
    expect(f.confirms[0]?.["token_details"]).toEqual(f.events[0]?.["token_details"]);
  });

  it.each([
    "iterate",
    "done",
    "on",
    "once",
    "emitted",
  ] as const)("activates via %s and settles event usage once", async (method) => {
    const f = fixture();
    const helper = f.solwyn.responses.stream({ input: "12345678" });
    const received: unknown[] = [];
    if (method === "iterate") {
      for await (const event of helper) received.push(event);
      expect(received).toHaveLength(2);
    } else if (method === "done") await helper.done();
    else if (method === "emitted") await helper.emitted("response.completed");
    else await new Promise<void>((resolve) => helper[method]("end", resolve));
    await f.solwyn.close();
    expect(f.streamCall).toHaveBeenCalledTimes(1);
    expect(f.checks).toHaveLength(1);
    expect(f.confirms).toHaveLength(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ input_tokens: 18, output_tokens: 7 });
  });

  it("pre-start abort has no provider or settlement effects", async () => {
    const f = fixture();
    const helper = f.solwyn.responses.stream({ input: "12345678" });
    helper.off("end", () => {});
    helper.abort();
    await expect(helper.done()).rejects.toMatchObject({ name: "AbortError" });
    await f.solwyn.close();
    expect(f.streamCall).not.toHaveBeenCalled();
    expect(f.checks).toHaveLength(0);
    expect(f.confirms).toHaveLength(0);
    expect(f.events).toHaveLength(0);
  });

  it.each([
    { label: "FAIL_FAST", status: 400, blocked: false, ambiguous: false },
    { label: "FAILOVER", status: 429, blocked: true, ambiguous: false },
    { label: "POST_SEND_AMBIGUOUS", status: null, blocked: true, ambiguous: true },
  ])("classifies $label before connect without failover", async ({
    status,
    blocked,
    ambiguous,
  }) => {
    const f = fixture(undefined, {
      circuitBreakerFailureThreshold: 1,
      failoverIdempotency: "always",
    });
    f.providerFetch.mockImplementationOnce(async () => {
      if (status === null) throw new Error("opaque transport failure");
      return new Response(JSON.stringify({ error: { message: "opaque", type: "fixture" } }), {
        status,
      });
    });
    const helper = f.solwyn.responses.stream({ input: "12345678" });
    await expect(helper.finalResponse()).rejects.toBeInstanceOf(Error);
    const second = f.solwyn.responses.stream({ input: "12345678" });
    if (blocked)
      await expect(second.done()).rejects.toMatchObject({ name: "ProviderUnavailableError" });
    else await second.done();
    await f.solwyn.close();
    expect(f.streamCall).toHaveBeenCalledTimes(blocked ? 1 : 2);
    expect(f.events[0]).toMatchObject({ status: "error" });
    if (ambiguous) expect(f.events[0]).toHaveProperty("possibly_succeeded", true);
    else expect(f.events[0]).not.toHaveProperty("possibly_succeeded", true);
    expect(f.confirms).toHaveLength(blocked ? 0 : 1);
  });

  it("refuses effective background before options overrides on first use", async () => {
    const f = fixture(undefined, { defaultParams: { background: true } });
    const helper = f.solwyn.responses.stream({ input: "hi" }, { body: {} } as never);
    expect(f.checks).toHaveLength(0);
    await expect(helper.done()).rejects.toMatchObject({
      name: "ConfigurationError",
      field: "background",
    });
    expect(f.streamCall).not.toHaveBeenCalled();
    expect(f.checks).toHaveLength(0);
    await f.solwyn.close();
  });

  it("stops an active helper before observing another event", async () => {
    const f = fixture();
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const encode = new TextEncoder();
    const push = (value: unknown) =>
      wire.enqueue(encode.encode(`data: ${JSON.stringify(value)}\n\n`));
    f.providerFetch.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              wire = controller;
              push({
                type: "response.created",
                sequence_number: 0,
                response: { id: "resp_stop", output: [] },
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await run("helper-stop", async () => {
      const helper = f.solwyn.responses.stream({ input: "12345678" });
      const iterator = helper[Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({ done: false });
      markTerminated(currentRun()?.agentRunId as string, {
        reason: "run_stopped",
        source: "server",
      });
      push({
        type: "response.completed",
        sequence_number: 1,
        response: { id: "resp_stop", output: [], usage: { input_tokens: 18, output_tokens: 7 } },
      });
      wire.close();
      await expect(iterator.next()).rejects.toMatchObject({ name: "RunStoppedError" });
      await expect(helper.finalResponse()).rejects.toMatchObject({ name: "RunStoppedError" });
    });
    await f.solwyn.close();
    expect(f.confirms).toHaveLength(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ status: "success", input_tokens: 2, output_tokens: 0 });
    resetRunControlForTest();
  });

  it("pins provider attribution at issuance before a later baseURL mutation", async () => {
    __resetAdapterRegistry();
    const f = fixture();
    const helper = f.solwyn.responses.stream({ input: "hi" });
    f.provider.baseURL = "https://fixture.openai.azure.com/openai/v1";
    await helper.done();
    await f.solwyn.close();
    expect(f.checks[0]).toHaveProperty("provider", "openai");
    expect(f.confirms[0]).toHaveProperty("provider", "openai");
  });

  it("does not retry a synchronously rejected helper entry", async () => {
    const f = fixture(undefined, { sameProviderRetries: 1 });
    const error = Object.assign(new Error("opaque"), {
      status: 429,
      headers: { "retry-after": "0" },
    });
    f.streamCall.mockImplementationOnce(() => {
      throw error;
    });
    const helper = f.solwyn.responses.stream({ input: "hi" });
    await expect(helper.done()).rejects.toBe(error);
    await f.solwyn.close();
    expect(f.streamCall).toHaveBeenCalledTimes(1);
    expect(f.checks).toHaveLength(1);
    expect(f.confirms).toHaveLength(0);
  });

  it("uses established-stream error semantics after connect", async () => {
    const f = fixture(undefined, { circuitBreakerFailureThreshold: 1 });
    f.providerFetch.mockImplementationOnce(
      async () =>
        new Response(
          'data: {"type":"response.completed","sequence_number":0,"response":{"id":"missing-created"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(f.solwyn.responses.stream({ input: "hi" }).done()).rejects.toBeInstanceOf(Error);
    await expect(f.solwyn.responses.stream({ input: "hi" }).done()).rejects.toMatchObject({
      name: "ProviderUnavailableError",
    });
    await f.solwyn.close();
    expect(f.streamCall).toHaveBeenCalledTimes(1);
    expect(f.confirms).toHaveLength(0);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ status: "error", possibly_succeeded: true });
  });

  it.each([
    "https://api.openai.com/v1",
    "https://fixture.openai.azure.com/openai/v1",
  ])("%s measured helper usage releases unused lease reservation", async (baseURL) => {
    const f = fixture(baseURL, { leaseEnabled: true, velocityMode: "off", tags: undefined });
    await run("helper-lease", () =>
      f.solwyn.responses.stream({ input: "12345678", max_output_tokens: 100 }).done(),
    );
    await f.solwyn.close();
    expect(f.confirms).toHaveLength(1);
    expect(f.confirms[0]?.["token_details"]).toMatchObject({
      input_tokens: 18,
      output_tokens: 7,
      cached_input_tokens: 5,
      reasoning_tokens: 3,
    });
    expect(f.surrenders).toHaveLength(1);
    expect(f.surrenders[0]).toHaveProperty("spent_tokens", 25);
  });

  it.each([
    "missing",
    "zero",
  ] as const)("holds the real helper lease floor for %s terminal usage", async (usage) => {
    const f = fixture(undefined, { leaseEnabled: true, tags: undefined, velocityMode: "off" });
    f.providerFetch.mockImplementationOnce(async () => {
      const response = {
        id: "resp_empty",
        output: [],
        ...(usage === "zero" ? { usage: { input_tokens: 0, output_tokens: 0 } } : {}),
      };
      return new Response(
        [
          { type: "response.created", sequence_number: 0, response },
          { type: "response.completed", sequence_number: 1, response },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    await run("helper-unmeasured", () =>
      f.solwyn.responses.stream({ input: "12345678", max_output_tokens: 100 }).done(),
    );
    await f.solwyn.close();
    expect(f.confirms).toHaveLength(1);
    expect(f.confirms[0]?.["token_details"]).toMatchObject({
      input_tokens: 2,
      output_tokens: 0,
      is_estimated: true,
    });
    expect(f.surrenders[0]).toHaveProperty("spent_tokens", 102);
  });

  it("abandoning an activated helper settles the lease floor once", async () => {
    const f = fixture(undefined, { leaseEnabled: true, tags: undefined, velocityMode: "off" });
    f.providerFetch.mockImplementationOnce(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_abandoned","output":[]}}\n\n',
                ),
              );
              init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await run("helper-abandoned", async () => {
      const helper = f.solwyn.responses.stream({ input: "12345678", max_output_tokens: 100 });
      const iterator = helper[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      await expect(helper.done()).rejects.toMatchObject({ name: "Error" });
      helper.abort();
    });
    await f.solwyn.close();
    expect(f.confirms).toHaveLength(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ status: "success", input_tokens: 2, output_tokens: 0 });
    expect(f.surrenders[0]).toHaveProperty("spent_tokens", 102);
  });

  it.each([
    "already aborted",
    "pending connection",
  ] as const)("classifies a request signal cancellation (%s) before connect without success or health verdict", async (phase) => {
    const f = fixture(undefined, { circuitBreakerFailureThreshold: 1 });
    const controller = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    if (phase === "already aborted") controller.abort();
    else {
      f.providerFetch.mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
            started();
          }),
      );
    }
    const helper = f.solwyn.responses.stream({ input: "hi" }, { signal: controller.signal });
    const outcome = expect(helper.done()).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
    if (phase === "pending connection") {
      await requestStarted;
      controller.abort();
    }
    await outcome;
    await f.solwyn.close();
    expect(f.streamCall).toHaveBeenCalledTimes(1);
    expect(f.providerFetch).toHaveBeenCalledTimes(phase === "already aborted" ? 0 : 1);
    expect(f.checks).toHaveLength(1);
    expect(f.confirms).toHaveLength(0);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      status: "error",
      failover_error_class: "APIUserAbortError",
    });
    expect(f.events[0]).not.toHaveProperty("possibly_succeeded");
    expect(f.breakerReports).toHaveLength(1);
    expect(f.breakerReports[0]).toMatchObject({
      provider: "openai",
      failure_count: 0,
      success_count: 0,
    });
  });

  it("handles rejected adapter initialization when the issued helper is pre-aborted", async () => {
    __setAdapterLoadersForTesting({
      openai: async () => {
        throw new Error("adapter unavailable");
      },
    });
    const f = fixture();
    const helper = f.solwyn.responses.stream({ input: "hi" });
    helper.abort();
    await expect(helper.done()).rejects.toMatchObject({ name: "AbortError" });
    await f.solwyn.close();
    expect(f.checks).toHaveLength(0);
    expect(f.streamCall).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(0);
  });

  it("retains native stream parameters and the supported deferred helper shape", async () => {
    const f = fixture();
    expectTypeOf<Parameters<typeof f.solwyn.responses.stream>>().toEqualTypeOf<
      Parameters<typeof f.provider.responses.stream>
    >();
    const helper = f.solwyn.responses.stream({ model: "gpt-4o", input: "hi" });
    type NativeHelper = ReturnType<
      typeof f.provider.responses.stream<{ model: string; input: string }>
    >;
    expectTypeOf<keyof typeof helper>().toEqualTypeOf<Exclude<keyof NativeHelper, "_emit">>();
    expectTypeOf(helper.done).toEqualTypeOf<NativeHelper["done"]>();
    expectTypeOf(helper.finalResponse).toEqualTypeOf<NativeHelper["finalResponse"]>();
    helper.abort();
    await f.solwyn.close();
  });

  it("aborts an invalid returned helper without issuing a success settlement", async () => {
    const f = fixture();
    const abort = vi.fn();
    f.streamCall.mockReturnValueOnce({
      controller: new AbortController(),
      abort,
      async *[Symbol.asyncIterator]() {},
    } as never);
    await expect(f.solwyn.responses.stream({ input: "hi" }).done()).rejects.toMatchObject({
      name: "SolwynError",
    });
    await f.solwyn.close();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(f.confirms).toHaveLength(0);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toHaveProperty("status", "error");
  });

  it.each([
    "responses.create",
    "responses.parse",
    "responses.stream",
  ])("rejects the metered acknowledgment token %s", (token) => {
    expect(() => fixture(undefined, { acknowledgeUntracked: [token] })).toThrow(
      /acknowledge_untracked/,
    );
    expect(() =>
      fixture("https://fixture.openai.azure.com/openai/v1", { acknowledgeUntracked: [token] }),
    ).toThrow(/acknowledge_untracked/);
  });

  it("keeps retrieve acknowledgeable alongside the metered stream helper", async () => {
    const f = fixture(undefined, { acknowledgeUntracked: ["responses.retrieve"] });
    const helper = f.solwyn.responses.stream({ input: "hi" });
    helper.abort();
    await f.solwyn.close();
    expect(f.checks).toHaveLength(0);
  });
});
