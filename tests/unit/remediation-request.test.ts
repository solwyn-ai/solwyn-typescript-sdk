import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { BudgetExceededError, ConfigurationError, Solwyn } from "../../src/index";
import { currentRun, run } from "../../src/node";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const usage = { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
function response(stream: boolean) {
  return stream
    ? new Response(`data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    : Response.json(usage);
}
function options(plane: FakeControlPlane) {
  return {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    logger,
    leaseEnabled: false,
    breakerReportingEnabled: false,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetRunControlForTest();
});

describe("review request/admission regressions", () => {
  it("F2 rejects target-owned Google whole-body overrides before admission", async () => {
    const plane = new FakeControlPlane();
    let dispatched = 0;
    vi.stubGlobal("fetch", async () => {
      dispatched++;
      return Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    });
    const client = new Solwyn(new GoogleGenAI({ apiKey: crypto.randomUUID() }), {
      ...options(plane),
      fallback: [
        [
          new GoogleGenAI({ apiKey: crypto.randomUUID() }),
          "gemini-2.5-pro",
          {
            config: {
              httpOptions: { extraBody: { generationConfig: { maxOutputTokens: 16000 } } },
            },
          },
        ],
      ],
    });
    try {
      await expect(
        client.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [] }],
          config: { maxOutputTokens: 128 },
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(plane.checks).toHaveLength(0);
      expect(dispatched).toBe(0);
    } finally {
      await client.close();
    }
  });

  for (const stream of [false, true]) {
    it.each([
      false,
      true,
    ])(`F1 scopes native Google HTTP settings to the served client (same client=%s, stream=${stream})`, async (sameClient) => {
      const plane = new FakeControlPlane();
      const sourceHeader = crypto.randomUUID();
      const targetHeader = crypto.randomUUID();
      let attempts = 0;
      let targetAuthorized = false;
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        if (++attempts === 1) {
          return Response.json(
            { error: { code: 429, status: "RESOURCE_EXHAUSTED" } },
            { status: 429 },
          );
        }
        targetAuthorized =
          new Headers(init?.headers).get("authorization") ===
          (sameClient ? sourceHeader : targetHeader);
        const result = { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        return stream
          ? new Response(`data: ${JSON.stringify(result)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          : Response.json(result);
      });
      const primary = new GoogleGenAI({ apiKey: crypto.randomUUID() });
      const fallback = sameClient ? primary : new GoogleGenAI({ apiKey: crypto.randomUUID() });
      const client = new Solwyn(primary, {
        ...options(plane),
        fallback: [
          [
            fallback,
            "gemini-2.5-pro",
            { config: { httpOptions: { headers: { authorization: targetHeader } } } },
          ],
        ],
      });
      const params = {
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [] }],
        config: {
          maxOutputTokens: 128,
          httpOptions: { headers: { authorization: sourceHeader } },
        },
      };
      try {
        if (stream) {
          const paid = await client.models.generateContentStream(params);
          for await (const _chunk of paid) {
          }
        } else await client.models.generateContent(params);
        expect(targetAuthorized).toBe(true);
      } finally {
        await client.close();
      }
    });

    it.each([
      false,
      true,
    ])(`F1 scopes native compatible credentials to the served client (same client=%s, stream=${stream})`, async (sameClient) => {
      const plane = new FakeControlPlane();
      const sourceHeader = `Bearer ${crypto.randomUUID()}`;
      const targetKey = crypto.randomUUID();
      const controller = new AbortController();
      let attempts = 0;
      let sourceAuthorized = false;
      let targetAuthorized = false;
      let targetSignal = false;
      const primary = new OpenAI({
        apiKey: crypto.randomUUID(),
        baseURL: "https://source-compatible.invalid/v1",
        fetch: async (_url, init) => {
          attempts++;
          const headers = new Headers(init?.headers);
          if (attempts === 1) {
            sourceAuthorized = headers.get("authorization") === sourceHeader;
            return new Response(null, { status: 429 });
          }
          targetAuthorized = headers.get("authorization") === sourceHeader;
          targetSignal = init?.signal instanceof AbortSignal;
          return response(stream);
        },
      });
      const fallback = sameClient
        ? primary
        : new OpenAI({
            apiKey: targetKey,
            baseURL: "https://target-compatible.invalid/v1",
            fetch: async (_url, init) => {
              const headers = new Headers(init?.headers);
              targetAuthorized =
                headers.get("authorization") === `Bearer ${targetKey}` &&
                headers.get("authorization") !== sourceHeader;
              targetSignal = init?.signal instanceof AbortSignal;
              return response(stream);
            },
          });
      const client = new Solwyn(primary, {
        ...options(plane),
        fallback: [[fallback, "compatible-fallback-model"]],
      });
      try {
        const paid = await client.chat.completions.create(
          { model: "compatible-primary-model", messages: [], max_tokens: 128, stream },
          { headers: { authorization: sourceHeader }, signal: controller.signal },
        );
        if (stream)
          for await (const _chunk of paid as AsyncIterable<unknown>) {
          }
        expect(plane.checks[0]?.provider).toBe("openai_compatible");
        expect(sourceAuthorized).toBe(true);
        expect(targetAuthorized).toBe(true);
        expect(targetSignal).toBe(true);
      } finally {
        await client.close();
      }
    });
  }

  it.each([
    ["https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "max_tokens"],
    ["https://api.openai.com/v1", "gpt-4o", "max_tokens"],
    ["https://api.openai.com/v1", "gpt-5", "max_completion_tokens"],
  ])("F8 normalizes translated Google cap into native %s %s", async (baseURL, model, capKey) => {
    const plane = new FakeControlPlane();
    const checks = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 }),
    );
    let cap: unknown;
    let hasOtherAlias = false;
    const fallback = new OpenAI({
      apiKey: crypto.randomUUID(),
      baseURL,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        cap = body[capKey ?? ""];
        hasOtherAlias = Object.hasOwn(
          body,
          capKey === "max_tokens" ? "max_completion_tokens" : "max_tokens",
        );
        return response(false);
      },
    });
    const client = new Solwyn(new GoogleGenAI({ apiKey: crypto.randomUUID() }), {
      ...options(plane),
      provider: "google",
      fallback: [[fallback, model ?? "", { max_tokens: 16000 }]],
    });
    try {
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [] }],
        config: { maxOutputTokens: 128 },
      });
      expect(checks.mock.calls[0]?.[0].estimatedOutputBound).toBe(128);
      expect(cap).toBe(128);
      expect(hasOtherAlias).toBe(false);
    } finally {
      await client.close();
    }
  });

  it.each([
    false,
    true,
  ])("F1 preserves cancellation through native OpenAI to Google fallback (stream=%s)", async (stream) => {
    const plane = new FakeControlPlane();
    const controller = new AbortController();
    const sourceHeader = `Bearer ${crypto.randomUUID()}`;
    const fallbackKey = crypto.randomUUID();
    let googleOwnAuth = false;
    let receivedSignal = false;
    let paid = false;
    const abort = new DOMException("", "AbortError");
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      googleOwnAuth =
        headers.get("x-goog-api-key") === fallbackKey &&
        headers.get("authorization") !== sourceHeader;
      receivedSignal = init?.signal instanceof AbortSignal;
      if (!init?.signal) {
        paid = true;
        return Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
      }
      const signal = init.signal;
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(abort), { once: true });
        controller.abort();
        if (!signal.aborted) {
          paid = true;
          resolve(
            Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
          );
        }
      });
    });
    const primary = new OpenAI({
      apiKey: crypto.randomUUID(),
      fetch: async () => new Response(null, { status: 429 }),
    });
    const fallback = new GoogleGenAI({ apiKey: fallbackKey });
    const client = new Solwyn(primary, {
      ...options(plane),
      fallback: [[fallback, "gemini-2.5-flash"]],
    });
    try {
      await expect(
        client.chat.completions.create(
          { model: "gpt-4o", messages: [{ role: "user", content: [] }], max_tokens: 128, stream },
          { signal: controller.signal, headers: { Authorization: sourceHeader } },
        ),
      ).rejects.toBe(abort);
      expect(googleOwnAuth).toBe(true);
      expect(receivedSignal).toBe(true);
      expect(paid).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("F1 strips native Google HTTP credentials on an OpenAI fallback and preserves cancellation", async () => {
    const plane = new FakeControlPlane();
    const marker = crypto.randomUUID();
    const fallbackKey = crypto.randomUUID();
    const sourceHeader = `Bearer ${marker}`;
    let primaryOwnHeader = false;
    let fallbackOwnHeader = false;
    const controller = new AbortController();
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      primaryOwnHeader = new Headers(init?.headers).get("authorization") === sourceHeader;
      return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 });
    });
    const fallback = new OpenAI({
      apiKey: fallbackKey,
      fetch: async (_url, init) => {
        fallbackOwnHeader =
          new Headers(init?.headers).get("authorization") === `Bearer ${fallbackKey}`;
        return response(false);
      },
    });
    const create = vi.spyOn(fallback.chat.completions, "create");
    const client = new Solwyn(new GoogleGenAI({ apiKey: crypto.randomUUID() }), {
      ...options(plane),
      provider: "google",
      fallback: [[fallback, "gpt-4o"]],
    });
    try {
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [] }],
        config: {
          maxOutputTokens: 128,
          abortSignal: controller.signal,
          httpOptions: { headers: { authorization: sourceHeader } },
        },
      });
      expect(primaryOwnHeader).toBe(true);
      expect(fallbackOwnHeader).toBe(true);
      expect(create.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    } finally {
      await client.close();
    }
  });

  it.each([
    "body",
    "fetchOptions.body",
  ])("F2 snapshots native %s options before asynchronous budget admission", async (carrier) => {
    const plane = new FakeControlPlane();
    let admit = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sent: unknown[] = [];
    const client = new Solwyn(
      new OpenAI({
        apiKey: crypto.randomUUID(),
        fetch: async (_url, init) => {
          const wire = JSON.parse(String(init?.body));
          sent.push(wire.model, wire.max_tokens);
          return response(false);
        },
      }),
      {
        ...options(plane),
        fetch: async (url, init) => {
          if (url.endsWith("/budgets/check")) {
            entered();
            await gate;
          }
          return plane.fetch(url, init);
        },
      },
    );
    const nativeOptions: OpenAI.RequestOptions = { fetchOptions: {} };
    try {
      const pending = client.chat.completions.create(
        { model: "gpt-4o-mini", messages: [], max_tokens: 128 },
        nativeOptions,
      );
      await checking;
      if (carrier === "body") nativeOptions.body = { model: "gpt-4o", max_tokens: 16000 };
      else
        Reflect.set(
          nativeOptions.fetchOptions ?? {},
          "body",
          JSON.stringify({ model: "gpt-4o", max_tokens: 16000 }),
        );
      admit();
      await pending;
      expect(plane.checks[0]?.model).toBe("gpt-4o-mini");
      expect(sent).toEqual(["gpt-4o-mini", 128]);
    } finally {
      admit();
      await client.close();
    }
  });

  it("F7 snapshots native nested cap before asynchronous budget admission", async () => {
    const plane = new FakeControlPlane();
    const check = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    let admit = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sent: unknown;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)).generationConfig.maxOutputTokens;
      return Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    });
    const client = new Solwyn(new GoogleGenAI({ apiKey: crypto.randomUUID() }), {
      ...options(plane),
      provider: "google",
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/check")) {
          entered();
          await gate;
        }
        return plane.fetch(url, init);
      },
    });
    const config = { maxOutputTokens: 128 };
    try {
      const pending = client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [] }],
        config,
      });
      await checking;
      config.maxOutputTokens = 16000;
      admit();
      await pending;
      expect(check.mock.calls[0]?.[0].estimatedOutputBound).toBe(128);
      expect(sent).toBe(128);
    } finally {
      admit();
      await client.close();
    }
  });

  it.each([
    false,
    true,
  ])("F1 isolates native authorization across vendors (stream=%s)", async (stream) => {
    const plane = new FakeControlPlane();
    const primaryHeader = `Bearer ${crypto.randomUUID()}`;
    const fallbackKey = crypto.randomUUID();
    const seen: boolean[] = [];
    const primary = new OpenAI({
      apiKey: crypto.randomUUID(),
      logger,
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization") === primaryHeader);
        return new Response(null, { status: 429 });
      },
    });
    const fallback = new OpenAI({
      apiKey: fallbackKey,
      logger,
      baseURL: "https://api.groq.com/openai/v1",
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization") === `Bearer ${fallbackKey}`);
        return response(stream);
      },
    });
    const client = new Solwyn(primary, {
      ...options(plane),
      fallback: [[fallback, "llama-3.3-70b-versatile"]],
    });
    try {
      const result = await client.chat.completions.create(
        { model: "gpt-4o", messages: [], stream },
        { headers: { Authorization: primaryHeader }, signal: new AbortController().signal },
      );
      if (stream)
        for await (const _chunk of result as AsyncIterable<unknown>) {
        }
      expect(seen).toEqual([true, true]);
    } finally {
      await client.close();
    }
  });

  it.each(["body", "query"])("F2 rejects native %s overrides before admission", async (field) => {
    const plane = new FakeControlPlane();
    const fetch = vi.fn(async () => response(false));
    const client = new Solwyn(new OpenAI({ apiKey: crypto.randomUUID(), fetch }), options(plane));
    try {
      await expect(
        client.chat.completions.create(
          { model: "gpt-4o-mini", messages: [], max_tokens: 128 },
          { [field]: { model: "gpt-4o", max_tokens: 16000 } },
        ),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
      expect(plane.checks).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it.each([
    {
      fetchOptions: { body: JSON.stringify({ model: "gpt-4o", messages: [], max_tokens: 16000 }) },
    },
    { fetchOptions: { method: "GET" } },
    { method: "get" as const },
    { path: "/responses" },
    { defaultBaseURL: "https://api.groq.com/openai/v1" },
    { stream: true },
  ])("F2 rejects alternate native payload/surface overrides before I/O (%#)", async (requestOptions) => {
    const plane = new FakeControlPlane();
    const fetch = vi.fn(async () => response(false));
    const client = new Solwyn(new OpenAI({ apiKey: crypto.randomUUID(), fetch }), options(plane));
    try {
      await expect(
        client.chat.completions.create(
          { model: "gpt-4o-mini", messages: [], max_tokens: 128 },
          requestOptions as unknown as OpenAI.RequestOptions,
        ),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
      expect(plane.checks).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("F2 rejects payload overrides on native Anthropic and OpenAI media calls", async () => {
    const plane = new FakeControlPlane();
    const fetch = vi.fn(async () =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 1 }, content: [] }),
    );
    const anthropic = new Solwyn(
      new Anthropic({ apiKey: crypto.randomUUID(), fetch }),
      options(plane),
    );
    const openai = new Solwyn(new OpenAI({ apiKey: crypto.randomUUID(), fetch }), options(plane));
    try {
      await expect(
        anthropic.messages.create(
          { model: "claude-sonnet-4", messages: [], max_tokens: 128 },
          { body: { model: "claude-opus-4", max_tokens: 16000 } },
        ),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        openai.embeddings.create(
          { model: "text-embedding-3-small", input: [] },
          { body: { model: "text-embedding-3-large", input: [] } },
        ),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
      expect(plane.checks).toHaveLength(0);
    } finally {
      await anthropic.close();
      await openai.close();
    }
  });

  it("F2 rejects Google nested HTTP payload overrides before admission", async () => {
    const plane = new FakeControlPlane();
    const fetch = vi.fn(async () =>
      Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new Solwyn(new GoogleGenAI({ apiKey: crypto.randomUUID() }), {
      ...options(plane),
      provider: "google",
    });
    try {
      await expect(
        client.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [] }],
          config: {
            maxOutputTokens: 128,
            httpOptions: { extraBody: { generationConfig: { maxOutputTokens: 16000 } } },
          },
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
      expect(plane.checks).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it.each([
    128, 16000,
  ])("F7 projects native Google cap %s to admission and native serialization", async (cap) => {
    const plane = new FakeControlPlane();
    const checks = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    let dispatchedCap: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        dispatchedCap = JSON.parse(String(init?.body)).generationConfig.maxOutputTokens;
        return Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
      }),
    );
    const client = new Solwyn(new GoogleGenAI({ apiKey: crypto.randomUUID() }), {
      ...options(plane),
      provider: "google",
    });
    try {
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [] }],
        config: { maxOutputTokens: cap },
      });
      expect(checks.mock.calls[0]?.[0].estimatedOutputBound).toBe(cap);
      expect(dispatchedCap).toBe(cap);
    } finally {
      await client.close();
    }
  });

  it("F8 per-call alias wins defaults for both admission and native dispatch", async () => {
    const plane = new FakeControlPlane();
    const checks = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    let dispatchedCap: unknown;
    const client = new Solwyn(
      new OpenAI({
        apiKey: crypto.randomUUID(),
        fetch: async (_url, init) => {
          dispatchedCap = JSON.parse(String(init?.body)).max_completion_tokens;
          return response(false);
        },
      }),
      { ...options(plane), defaultParams: { max_completion_tokens: 16000 } },
    );
    try {
      await client.chat.completions.create({ model: "gpt-5", messages: [], max_tokens: 128 });
      expect(checks.mock.calls[0]?.[0].estimatedOutputBound).toBe(128);
      expect(dispatchedCap).toBe(128);
    } finally {
      await client.close();
    }
  });

  it.each([
    "same",
    "compat",
    "anthropic",
  ])("F8 resolves cap layers consistently through native %s fallback", async (target) => {
    const plane = new FakeControlPlane();
    const checks = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    const caps: unknown[] = [];
    const primary = new OpenAI({
      apiKey: crypto.randomUUID(),
      fetch: async (_url, init) => {
        caps.push(JSON.parse(String(init?.body)).max_completion_tokens);
        return new Response(null, { status: 429 });
      },
    });
    const fallbackFetch: typeof fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      caps.push(wire.max_completion_tokens ?? wire.max_tokens);
      return target === "anthropic"
        ? Response.json({
            type: "message",
            content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "end_turn",
          })
        : response(false);
    };
    const fallback =
      target === "anthropic"
        ? new Anthropic({ apiKey: crypto.randomUUID(), fetch: fallbackFetch })
        : new OpenAI({
            apiKey: crypto.randomUUID(),
            fetch: fallbackFetch,
            ...(target === "compat" ? { baseURL: "https://api.groq.com/openai/v1" } : {}),
          });
    const model =
      target === "anthropic"
        ? "claude-sonnet-4"
        : target === "compat"
          ? "llama-3.3-70b-versatile"
          : "gpt-5-mini";
    const client = new Solwyn(primary, {
      ...options(plane),
      defaultParams: { max_completion_tokens: 16000 },
      fallback: [[fallback, model, { max_completion_tokens: 8000 }]],
    });
    try {
      await client.chat.completions.create({ model: "gpt-5", messages: [], max_tokens: 128 });
      expect(checks.mock.calls[0]?.[0].estimatedOutputBound).toBe(128);
      expect(caps).toEqual([128, 128]);
    } finally {
      await client.close();
    }
  });

  it("F7 denies a native Google cap exceeding granted authority", async () => {
    const plane = new FakeControlPlane({
      grantedTokens: 5000,
      headroomShareTokens: 0,
      finalGrant: true,
    });
    plane.denyNext(1, { scope: "check" });
    const fetch = vi.fn(async () =>
      Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new Solwyn(new GoogleGenAI({ apiKey: crypto.randomUUID() }), {
      ...options(plane),
      provider: "google",
      leaseEnabled: true,
    });
    try {
      await run("google-authority", async () => {
        await client.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [] }],
          config: { maxOutputTokens: 128 },
        });
        await expect(
          client.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts: [] }],
            config: { maxOutputTokens: 16000 },
          }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(plane.checks).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it.each([
    "break",
    "close",
    "stop",
  ])("F9 closes native Google reader exactly once on %s", async (mode) => {
    const plane = new FakeControlPlane();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const push = () =>
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\n\n`,
        ),
      );
    push();
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    const google = new GoogleGenAI({ apiKey: crypto.randomUUID() });
    const native = google.models.generateContentStream.bind(google.models);
    let returns = 0;
    vi.spyOn(google.models, "generateContentStream").mockImplementation(async (params) => {
      const iterator = await native(params);
      const originalReturn = iterator.return.bind(iterator);
      iterator.return = async (value) => {
        returns++;
        return originalReturn(value);
      };
      return iterator;
    });
    const client = new Solwyn(google, { ...options(plane), provider: "google" });
    try {
      await run("native-cleanup", async () => {
        const source = (await client.models.generateContentStream({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [] }],
        })) as unknown as AsyncIterableIterator<unknown> & { close(): Promise<void> };
        if (mode === "break") {
          for await (const _chunk of source) break;
        } else if (mode === "close") await source.close();
        else {
          await source.next();
          markTerminated(currentRun()?.agentRunId ?? "missing-run", {
            reason: "run_stopped",
            source: "server",
          });
          push();
          await expect(source.next()).rejects.toMatchObject({ name: "RunStoppedError" });
        }
        await source.close();
        expect(body.locked).toBe(false);
        expect(returns).toBe(1);
      });
    } finally {
      controller.close();
      await client.close();
    }
    expect(plane.confirms).toHaveLength(1);
  });

  it.each([
    false,
    true,
  ])("F11 preserves native paid response with invalid usage (stream=%s)", async (stream) => {
    const plane = new FakeControlPlane();
    const invalid = { choices: [], usage: { prompt_tokens: 100_000_001, completion_tokens: 1 } };
    const client = new Solwyn(
      new OpenAI({
        apiKey: crypto.randomUUID(),
        fetch: async () =>
          stream
            ? new Response(`data: ${JSON.stringify(invalid)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
              })
            : Response.json(invalid),
      }),
      options(plane),
    );
    try {
      const result = await client.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        stream,
      });
      if (stream) {
        let chunks = 0;
        for await (const _chunk of result as AsyncIterable<unknown>) chunks++;
        expect(chunks).toBe(1);
      } else expect(result).toMatchObject(invalid);
    } finally {
      await client.close();
    }
  });

  it.each([
    false,
    true,
  ])("F11 never refunds unknown paid lease spend (stream=%s)", async (stream) => {
    const plane = new FakeControlPlane({
      grantedTokens: 600,
      headroomShareTokens: 0,
      finalGrant: true,
    });
    plane.denyNext(1, { scope: "check" });
    const invalid = { choices: [], usage: { prompt_tokens: 100_000_001, completion_tokens: 1 } };
    const fetch = vi.fn(async () =>
      stream
        ? new Response(`data: ${JSON.stringify(invalid)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(invalid),
    );
    const client = new Solwyn(new OpenAI({ apiKey: crypto.randomUUID(), fetch }), {
      ...options(plane),
      leaseEnabled: true,
    });
    try {
      await run("paid-unknown-usage", async () => {
        const result = await client.chat.completions.create({
          model: "gpt-4o",
          messages: [],
          stream,
          max_tokens: 500,
        });
        if (stream)
          for await (const _chunk of result as AsyncIterable<unknown>) {
          }
        else expect(result).toMatchObject(invalid);
        await expect(
          client.chat.completions.create({ model: "gpt-4o", messages: [], max_tokens: 500 }),
        ).rejects.toBeInstanceOf(BudgetExceededError);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
    expect(plane.confirms).toHaveLength(0);
    expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(500);
  });

  it("F14 counts one provider failure across model fallback and terminal stream failure", async () => {
    const plane = new FakeControlPlane();
    const failures = vi.spyOn(CircuitBreaker.prototype, "recordFailure");
    const thrown = new Error();
    const primary = {
      chat: {
        completions: {
          create: async (_params: unknown) => {
            throw Object.assign(new Error(), { status: 429 });
          },
        },
      },
    };
    const fallback = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield usage;
              throw thrown;
            })(),
        },
      },
    };
    const client = new Solwyn(primary, {
      ...options(plane),
      fallback: [[fallback, "gpt-4o-mini"]],
      circuitBreakerFailureThreshold: 2,
    });
    try {
      const source = await client.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        stream: true,
      });
      await expect(
        (async () => {
          for await (const _chunk of source as AsyncIterable<unknown>) {
          }
        })(),
      ).rejects.toBe(thrown);
      expect(failures).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it("F19 preserves authoritative denial and receipt with a throwing suppression logger", async () => {
    const plane = new FakeControlPlane({ failoverTuningAllowed: false });
    plane.denyNext();
    const create = vi.fn(async (_params: unknown) => usage);
    const client = new Solwyn(
      { chat: { completions: { create } } },
      {
        ...options(plane),
        sameProviderRetries: 1,
        logger: {
          ...logger,
          warn() {
            throw new Error();
          },
        },
      },
    );
    try {
      await expect(
        client.chat.completions.create({ model: "gpt-4o", messages: [] }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
    } finally {
      await client.close();
    }
    expect(create).not.toHaveBeenCalled();
    expect(plane.denialReceipts).toHaveLength(1);
  });
});
