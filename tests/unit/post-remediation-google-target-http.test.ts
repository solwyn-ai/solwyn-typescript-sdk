import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import type { SolwynOptions } from "../../src/client";
import { ConfigurationError, noopLogger, Solwyn } from "../../src/index";
import { FakeControlPlane } from "../../src/testing";

type Source = "google" | "openai" | "anthropic";
const sources: Source[] = ["google", "openai", "anthropic"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function request(options: {
  source: Source;
  stream: boolean;
  plane: FakeControlPlane;
  targetKey: string;
  targetConfig: Record<string, unknown>;
  sourceKey: string;
  sourceHeader: string;
  marker: string;
  signal?: AbortSignal;
}): Promise<void> {
  const settings: SolwynOptions = {
    apiKey: options.plane.apiKey,
    apiUrl: options.plane.apiUrl,
    fetch: options.plane.fetch,
    logger: noopLogger,
    leaseEnabled: false,
    breakerReportingEnabled: false,
    reportUntrackedSurfaces: false,
    fallback: [
      [
        new GoogleGenAI({ apiKey: options.targetKey }),
        "gemini-2.5-flash",
        { config: options.targetConfig },
      ],
    ],
  };
  const sourceOptions = {
    signal: options.signal,
    headers: { authorization: options.sourceHeader, "x-source-secret": options.sourceHeader },
  };
  const failedFetch = async () => new Response(null, { status: 429 });
  const drain = async (value: unknown) => {
    if (options.stream)
      for await (const _chunk of value as AsyncIterable<unknown>) {
      }
  };
  if (options.source === "google") {
    const client = new Solwyn(new GoogleGenAI({ apiKey: options.sourceKey }), settings);
    const params = {
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: options.marker }] }],
      config: {
        maxOutputTokens: 128,
        temperature: 0.3,
        abortSignal: options.signal,
        httpOptions: { headers: sourceOptions.headers },
      },
    };
    try {
      await drain(
        options.stream
          ? await client.models.generateContentStream(params)
          : await client.models.generateContent(params),
      );
    } finally {
      await client.close();
    }
  } else if (options.source === "openai") {
    const client = new Solwyn(
      new OpenAI({ apiKey: options.sourceKey, fetch: failedFetch }),
      settings,
    );
    try {
      await drain(
        await client.chat.completions.create(
          {
            model: "gpt-4o",
            messages: [{ role: "user", content: options.marker }],
            max_tokens: 128,
            temperature: 0.3,
            stream: options.stream,
          },
          sourceOptions,
        ),
      );
    } finally {
      await client.close();
    }
  } else {
    const client = new Solwyn(
      new Anthropic({ apiKey: options.sourceKey, fetch: failedFetch }),
      settings,
    );
    try {
      await drain(
        await client.messages.create(
          {
            model: "claude-sonnet-4-5",
            messages: [{ role: "user", content: options.marker }],
            max_tokens: 128,
            temperature: 0.3,
            stream: options.stream,
          },
          sourceOptions,
        ),
      );
    } finally {
      await client.close();
    }
  }
}

describe("post-remediation finding 7: Google target HTTP ownership", () => {
  for (const stream of [false, true]) {
    it.each(
      sources,
    )(`preserves target headers and canonical precedence from %s (stream=${stream})`, async (source) => {
      const plane = new FakeControlPlane();
      const targetKey = crypto.randomUUID();
      const sourceKey = crypto.randomUUID();
      const targetHeader = crypto.randomUUID();
      const sourceHeader = crypto.randomUUID();
      const marker = crypto.randomUUID();
      const caller = new AbortController();
      const targetCancellation = new AbortController();
      targetCancellation.abort();
      let targetCalls = 0;
      let targetAuthorized = false;
      let sourceStripped = false;
      let contentPreserved = false;
      let callerCancellationWins = false;
      let dispatchedCap: unknown;
      let dispatchedTemperature: unknown;
      const check = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (headers.get("x-goog-api-key") === sourceKey)
          return Response.json({ error: { code: 429 } }, { status: 429 });
        targetCalls++;
        targetAuthorized =
          headers.get("authorization") === targetHeader &&
          headers.get("x-goog-api-key") === targetKey;
        sourceStripped = headers.get("x-source-secret") === null;
        callerCancellationWins = init?.signal?.aborted === false;
        const body = JSON.parse(String(init?.body));
        dispatchedCap = body.generationConfig?.maxOutputTokens;
        dispatchedTemperature = body.generationConfig?.temperature;
        contentPreserved = body.contents?.[0]?.parts?.[0]?.text === marker;
        const result = {
          candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20 },
        };
        return stream
          ? new Response(`data: ${JSON.stringify(result)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : Response.json(result);
      });
      await request({
        source,
        stream,
        plane,
        targetKey,
        sourceKey,
        sourceHeader,
        marker,
        signal: caller.signal,
        targetConfig: {
          maxOutputTokens: 16_000,
          temperature: 0.9,
          abortSignal: targetCancellation.signal,
          httpOptions: { headers: { authorization: targetHeader } },
        },
      });
      expect(targetCalls).toBe(1);
      expect(targetAuthorized).toBe(true);
      expect(sourceStripped).toBe(true);
      expect(contentPreserved).toBe(true);
      expect(callerCancellationWins).toBe(true);
      expect(dispatchedCap).toBe(128);
      expect(dispatchedTemperature).toBe(0.3);
      expect(check.mock.calls[0]?.[0].estimatedOutputBound).toBe(128);
      expect(plane.confirms).toHaveLength(1);
      expect(plane.confirms[0]?.provider).toBe("google");
    });

    it.each(
      sources,
    )(`maps cancellation to the admitted Google target from %s (stream=${stream})`, async (source) => {
      const plane = new FakeControlPlane();
      const targetKey = crypto.randomUUID();
      const sourceKey = crypto.randomUUID();
      const targetHeader = crypto.randomUUID();
      const caller = new AbortController();
      const abort = new DOMException("", "AbortError");
      let targetAuthorized = false;
      let targetAborted = false;
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (headers.get("x-goog-api-key") === sourceKey)
          return Response.json({ error: { code: 429 } }, { status: 429 });
        targetAuthorized = headers.get("authorization") === targetHeader;
        const signal = init?.signal;
        if (!signal) throw new Error("Expected native cancellation carrier");
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              targetAborted = true;
              reject(abort);
            },
            { once: true },
          );
          caller.abort();
        });
      });
      await expect(
        request({
          source,
          stream,
          plane,
          targetKey,
          sourceKey,
          sourceHeader: crypto.randomUUID(),
          marker: crypto.randomUUID(),
          signal: caller.signal,
          targetConfig: { httpOptions: { headers: { authorization: targetHeader } } },
        }),
      ).rejects.toBe(abort);
      expect(targetAuthorized).toBe(true);
      expect(targetAborted).toBe(true);
      expect(plane.confirms).toHaveLength(0);
    });
  }

  it.each(sources)("rejects target HTTP payload overrides before %s admission", async (source) => {
    const plane = new FakeControlPlane();
    let dispatched = 0;
    vi.stubGlobal("fetch", async () => {
      dispatched++;
      throw new Error("Unexpected provider dispatch");
    });
    await expect(
      request({
        source,
        stream: false,
        plane,
        targetKey: crypto.randomUUID(),
        sourceKey: crypto.randomUUID(),
        sourceHeader: crypto.randomUUID(),
        marker: crypto.randomUUID(),
        targetConfig: {
          httpOptions: { extraBody: { generationConfig: { maxOutputTokens: 16_000 } } },
        },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(dispatched).toBe(0);
    expect(plane.checks).toHaveLength(0);
  });
});
