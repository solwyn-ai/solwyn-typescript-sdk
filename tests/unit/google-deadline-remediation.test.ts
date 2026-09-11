import { GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAdapter } from "../../src/providers/google";

const parameters = {
  model: "gemini-2.5-flash",
  contents: [{ role: "user", parts: [] }],
  config: { maxOutputTokens: 1 },
};
const usage = { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } };
const adapter = new GoogleAdapter();
const options = {
  surface: "chat" as const,
  crossProvider: false,
  isStreaming: false,
  timeout: 0.05,
  maxRetries: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native Google request deadline ownership", () => {
  it.each([
    "missing",
    "conflicting",
    "older",
    "future major",
    "malformed",
  ])("keeps a finite native bound when SDK metadata is %s", async (kind) => {
    vi.useFakeTimers();
    const native = new GoogleGenAI({ apiKey: crypto.randomUUID() });
    const apiClient = Reflect.get(native.models, "apiClient");
    const clientOptions = Reflect.get(apiClient, "clientOptions");
    const headers = clientOptions.httpOptions.headers;
    if (kind === "missing") {
      delete headers["x-goog-api-client"];
    } else if (kind === "conflicting") {
      headers["User-Agent"] = "google-genai-sdk/0.3.1";
    } else {
      const version = kind === "older" ? "0.3.1" : kind === "future major" ? "99.0.0" : "invalid";
      headers["User-Agent"] = `google-genai-sdk/${version}`;
      headers["x-goog-api-client"] = `google-genai-sdk/${version}`;
    }
    vi.stubGlobal("fetch", async () => Response.json(usage));
    await adapter.prepareCall(native, parameters, options)();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not evaluate getters while checking optional SDK metadata", () => {
    const metadata = vi.fn(() => {
      throw new Error("metadata getter must stay untouched");
    });
    let nativeBound: unknown;
    const models = {
      get apiClient() {
        return metadata();
      },
      generateContent(params: Record<string, unknown>) {
        nativeBound = Reflect.get(
          Reflect.get(params["config"] as object, "httpOptions"),
          "timeout",
        );
        return usage;
      },
    };
    expect(adapter.prepareCall({ models }, parameters, options)()).toBe(usage);
    expect(metadata).not.toHaveBeenCalled();
    expect(nativeBound).toBe(50);
  });

  it.each([200, 400])("disposes the buffered deadline after HTTP %s", async (status) => {
    vi.useFakeTimers();
    const native = new GoogleGenAI({
      apiKey: crypto.randomUUID(),
      httpOptions: { timeout: 600_000 },
    });
    vi.stubGlobal("fetch", async () => Response.json(usage, { status }));
    const call = adapter.prepareCall(native, parameters, options)();
    if (status === 200) await call;
    else await expect(call).rejects.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes the native media deadline after completion", async () => {
    vi.useFakeTimers();
    const native = new GoogleGenAI({ apiKey: crypto.randomUUID() });
    vi.stubGlobal("fetch", async () => Response.json({ embeddings: [{ values: [] }] }));
    const prepared = adapter.prepareMediaCall("embeddings", native, parameters, options);
    await prepared.method(prepared.kwargs);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "exhaust",
    "break",
    "return",
    "unstarted return",
  ])("disposes the stream deadline and releases its native reader on %s", async (ending) => {
    vi.useFakeTimers();
    const native = new GoogleGenAI({ apiKey: crypto.randomUUID() });
    const generate = native.models.generateContentStream.bind(native.models);
    let returns = 0;
    vi.spyOn(native.models, "generateContentStream").mockImplementation(async (params) => {
      const source = await generate(params);
      const originalReturn = source.return.bind(source);
      source.return = async (value) => {
        returns++;
        return originalReturn(value);
      };
      return source;
    });
    const response = new Response(
      `data: ${JSON.stringify(usage)}\n\ndata: ${JSON.stringify(usage)}\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
    vi.stubGlobal("fetch", async () => response);
    const source = (await adapter.prepareCall(native, parameters, {
      ...options,
      isStreaming: true,
    })()) as AsyncIterableIterator<unknown>;
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    if (ending === "exhaust" || ending === "break") {
      for await (const _chunk of source) {
        if (ending === "break") break;
      }
    } else {
      if (ending === "return") await source.next();
      await source.return?.();
      await source.return?.();
    }
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(returns).toBe(ending === "exhaust" ? 0 : 1);
  });

  it.each([
    "deadline",
    "caller",
  ])("keeps active buffered cancellation effective (%s)", async (cause) => {
    vi.useFakeTimers();
    const native = new GoogleGenAI({ apiKey: crypto.randomUUID() });
    const caller = new AbortController();
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let activeSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      activeSignal = init.signal ?? undefined;
      reached();
      return new Promise<Response>((_resolve, reject) => {
        activeSignal?.addEventListener("abort", () => reject(activeSignal?.reason), { once: true });
      });
    });
    const call = adapter.prepareCall(
      native,
      { ...parameters, config: { ...parameters.config, abortSignal: caller.signal } },
      options,
    )();
    const rejected = expect(call).rejects.toBeDefined();
    await entered;
    if (cause === "deadline") {
      await vi.advanceTimersByTimeAsync(49);
      expect(activeSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    } else caller.abort();
    await rejected;
    expect(activeSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "deadline",
    "caller",
  ])("keeps active stream cancellation effective (%s)", async (cause) => {
    vi.useFakeTimers();
    const native = new GoogleGenAI({ apiKey: crypto.randomUUID() });
    const caller = new AbortController();
    let response: Response | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(usage)}\n\n`));
            init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      return response;
    });
    const source = (await adapter.prepareCall(
      native,
      { ...parameters, config: { ...parameters.config, abortSignal: caller.signal } },
      { ...options, isStreaming: true },
    )()) as AsyncIterableIterator<unknown>;
    expect((await source.next()).done).toBe(false);
    const rejected = expect(source.next()).rejects.toBeDefined();
    if (cause === "deadline") await vi.advanceTimersByTimeAsync(50);
    else caller.abort();
    await rejected;
    expect(response?.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
