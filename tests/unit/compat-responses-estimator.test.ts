/**
 * 2026-09-22 performance audit: "Stop throwing a TypeError on every compat Responses event".
 *
 * Responses stream events carry no `choices`. The OpenAI-dialect length estimators must
 * return without iterating on that shape instead of constructing and discarding a
 * not-iterable TypeError per event. Caught exceptions are counted structurally through a
 * same-thread inspector session that pauses on caught exceptions and resumes immediately;
 * the paused payload is never inspected.
 */

import { Session } from "node:inspector";
import { describe, expect, it } from "vitest";
import { noopLogger } from "../../src/logging";
import { estimateResponseContentLength, estimateStreamChunkContentLength } from "../../src/privacy";
import { COMPAT_PROFILES, OpenAICompatibleAdapter } from "../../src/providers/openai-compatible";

/** Run `fn` synchronously and return how many exceptions were thrown (caught or not) inside it. */
function countThrows(fn: () => void): number {
  const session = new Session();
  session.connect();
  let thrown = 0;
  session.on("Debugger.paused", () => {
    thrown++;
    session.post("Debugger.resume");
  });
  try {
    session.post("Debugger.enable");
    session.post("Debugger.setPauseOnExceptions", { state: "all" });
    fn();
  } finally {
    session.post("Debugger.setPauseOnExceptions", { state: "none" });
    session.post("Debugger.disable");
    session.disconnect();
  }
  return thrown;
}

/** A chunk whose every property read is recorded, standing in for a Responses event. */
function trappedResponsesEvent(reads: PropertyKey[]): object {
  const target = { type: "response.output_text.delta", sequence_number: 1, delta: "ok" };
  return new Proxy(target, {
    get(t, key, receiver) {
      reads.push(key);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      reads.push(key);
      return Reflect.has(t, key);
    },
    ownKeys(t) {
      reads.push("<ownKeys>");
      return Reflect.ownKeys(t);
    },
  });
}

describe("OpenAI-dialect estimators on chunks without choices", () => {
  it("the inspector counter observes a caught exception (harness self-check)", () => {
    expect(
      countThrows(() => {
        try {
          throw new Error("synthetic");
        } catch {
          // counted, never inspected
        }
      }),
    ).toBe(1);
  });

  it("a Responses stream event takes the non-throwing path and reads only `choices`", () => {
    const reads: PropertyKey[] = [];
    const event = trappedResponsesEvent(reads);
    let total = -1;
    const thrown = countThrows(() => {
      total = estimateStreamChunkContentLength(event);
    });
    expect(thrown).toBe(0);
    expect(total).toBe(0);
    expect(reads).toEqual(["choices"]);
  });

  it("a buffered Responses object takes the non-throwing path and reads only `choices`", () => {
    const reads: PropertyKey[] = [];
    const response = trappedResponsesEvent(reads);
    let total = -1;
    const thrown = countThrows(() => {
      total = estimateResponseContentLength(response);
    });
    expect(thrown).toBe(0);
    expect(total).toBe(0);
    expect(reads).toEqual(["choices"]);
  });

  it("null, undefined and non-iterable choices return 0 without throwing", () => {
    const shapes: unknown[] = [
      {},
      { choices: null },
      { choices: undefined },
      { choices: 42 },
      { choices: {} },
      null,
      undefined,
    ];
    let totals: number[] = [];
    const thrown = countThrows(() => {
      totals = shapes.flatMap((shape) => [
        estimateStreamChunkContentLength(shape),
        estimateResponseContentLength(shape),
      ]);
    });
    expect(thrown).toBe(0);
    expect(totals.every((total) => total === 0)).toBe(true);
  });

  it("keeps the never-raise contract for a hostile iterator getter", () => {
    const hostile = {
      get [Symbol.iterator](): never {
        throw new TypeError("hostile");
      },
    };
    expect(estimateStreamChunkContentLength({ choices: hostile })).toBe(0);
    expect(estimateResponseContentLength({ choices: hostile })).toBe(0);
  });

  it("keeps the partial total for an iterable that throws mid-walk", () => {
    function* choices(): Generator<unknown> {
      yield { delta: { content: "abc" }, message: { content: "abcd" } };
      throw new TypeError("mid-walk");
    }
    expect(estimateStreamChunkContentLength({ choices: choices() })).toBe(3);
    expect(estimateResponseContentLength({ choices: choices() })).toBe(4);
  });

  it("the Azure OpenAI compat accumulator observes Responses events without throwing", () => {
    const profile = COMPAT_PROFILES.find((p) => p.name === "azure_openai");
    if (profile === undefined) throw new Error("azure_openai profile missing");
    const adapter = new OpenAICompatibleAdapter(profile, { logger: noopLogger });
    const accumulator = adapter.createStreamAccumulator({ estimatedInputTokens: 2 });
    const events = Array.from({ length: 100 }, (_, i) => ({
      type: "response.output_text.delta",
      sequence_number: i,
      item_id: "msg_synthetic",
      output_index: 0,
      content_index: 0,
      delta: "ok",
    }));
    const thrown = countThrows(() => {
      for (const event of events) accumulator.observe(event);
    });
    expect(thrown).toBe(0);
  });
});
