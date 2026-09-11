import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { noopLogger, RunStoppedError, Solwyn } from "../../src/index";
import { currentRun, run } from "../../src/node";
import { markTerminated } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing/index";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(baseURL: string, failure = false, pauseCheck = false) {
  const plane = new FakeControlPlane();
  const fetched = gate<void>();
  const checked = gate<void>();
  const admitted = gate<void>();
  let dispatches = 0;
  let created = false;
  let body: ReadableStreamDefaultController<Uint8Array>;
  const provider = new OpenAI({
    apiKey: "offline",
    baseURL,
    maxRetries: 0,
    fetch: async (_url, init) => {
      dispatches++;
      if (failure) return new Response(null, { status: 500 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      });
      const abort = () => body.error(new DOMException("The operation was aborted.", "AbortError"));
      init?.signal?.addEventListener("abort", abort, { once: true });
      if (init?.signal?.aborted) abort();
      fetched.resolve();
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const client = new Solwyn(provider, {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: async (url, init) => {
      if (url.endsWith("/budgets/check")) {
        checked.resolve();
        if (pauseCheck) await admitted.promise;
      }
      return plane.fetch(url, init);
    },
    leaseEnabled: false,
    reportUntrackedSurfaces: false,
    logger: noopLogger,
  });
  const helper = client.responses.stream({ model: "gpt-test", input: [] });
  return {
    plane,
    client,
    helper,
    fetched,
    checked,
    admitted,
    dispatches: () => dispatches,
    start() {
      created = true;
      const event = {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_states", object: "response", status: "in_progress", output: [] },
      };
      body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    finish() {
      const response = {
        id: "resp_states",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      };
      const events = [
        {
          type: "response.created",
          sequence_number: 0,
          response: { ...response, status: "in_progress" },
        },
        { type: "response.completed", sequence_number: 1, response },
      ];
      body.enqueue(
        new TextEncoder().encode(
          events
            .slice(created ? 1 : 0)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        ),
      );
      body.close();
    },
  };
}

function flags(helper: { ended: boolean; errored: boolean; aborted: boolean }) {
  return [helper.ended, helper.errored, helper.aborted];
}

describe.each([
  "https://api.openai.com/v1",
  "https://native.openai.azure.com/openai/v1",
])("Responses helper state properties: %s", (baseURL) => {
  it("keeps reads inert and reports pending and completed native states", async () => {
    const f = fixture(baseURL);
    expect(flags(f.helper)).toEqual([false, false, false]);
    expect(f.plane.checks).toHaveLength(0);
    expect(f.dispatches()).toBe(0);
    const done = f.helper.done();
    await f.fetched.promise;
    expect(flags(f.helper)).toEqual([false, false, false]);
    f.finish();
    await done;
    expect(flags(f.helper)).toEqual([true, false, false]);
    f.helper.abort();
    expect(flags(f.helper)).toEqual([true, false, false]);
    await f.client.close();
    expect(f.plane.confirms).toHaveLength(1);
  });

  it("reports a provider startup failure as ended and errored", async () => {
    const f = fixture(baseURL, true);
    await expect(f.helper.done()).rejects.toBeInstanceOf(Error);
    expect(flags(f.helper)).toEqual([true, true, false]);
    f.helper.abort();
    expect(flags(f.helper)).toEqual([true, true, false]);
    await f.client.close();
  });

  it("reports failure state inside an end-only event subscription", async () => {
    const f = fixture(baseURL, true);
    const observed = gate<boolean[]>();
    f.helper.once("end", () => observed.resolve(flags(f.helper)));
    await expect(observed.promise).resolves.toEqual([true, true, false]);
    await expect(f.helper.done()).rejects.toBeInstanceOf(Error);
    expect(flags(f.helper)).toEqual([true, true, false]);
    await f.client.close();
  });

  it("reports an abort before activation without spending", async () => {
    const f = fixture(baseURL);
    f.helper.abort();
    await expect(f.helper.done()).rejects.toBeInstanceOf(Error);
    expect(flags(f.helper)).toEqual([true, true, true]);
    expect(f.plane.checks).toHaveLength(0);
    expect(f.dispatches()).toBe(0);
    await f.client.close();
  });

  it("reports an abort while admission is starting", async () => {
    const f = fixture(baseURL, false, true);
    const done = f.helper.done();
    await f.checked.promise;
    expect(flags(f.helper)).toEqual([false, false, false]);
    f.helper.abort();
    f.admitted.resolve();
    await expect(done).rejects.toBeInstanceOf(Error);
    expect(flags(f.helper)).toEqual([true, true, true]);
    await f.client.close();
  });

  it("reports an abort of an established native stream", async () => {
    const f = fixture(baseURL);
    const done = f.helper.done();
    await f.fetched.promise;
    f.helper.abort();
    await expect(done).rejects.toBeInstanceOf(Error);
    expect(flags(f.helper)).toEqual([true, true, true]);
    await f.client.close();
  });

  it("retains a run stop while reporting the native abort outcome", async () => {
    await run("responses-state-stop", async () => {
      const f = fixture(baseURL);
      const iterator = f.helper[Symbol.asyncIterator]();
      await f.fetched.promise;
      f.start();
      expect((await iterator.next()).done).toBe(false);
      const runId = currentRun()?.agentRunId;
      if (runId === undefined) throw new Error("missing run context");
      markTerminated(runId, { reason: "run_stopped", source: "server" });
      f.finish();
      await expect(iterator.next()).rejects.toBeInstanceOf(RunStoppedError);
      await expect(f.helper.done()).rejects.toBeInstanceOf(RunStoppedError);
      expect(flags(f.helper)).toEqual([true, true, true]);
      expect(f.helper.controller.signal.aborted).toBe(true);
      await f.client.close();
    });
  });
});
