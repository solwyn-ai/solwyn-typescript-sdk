import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";
import Together from "together-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetUnmeteredSurfaceWarnings } from "../../src/client";
import {
  BudgetExceededError,
  ConfigurationError,
  coverage,
  Solwyn,
  UnsupportedSurfaceError,
  UntrackedSpendSurfaceError,
} from "../../src/index";
import { detectBedrockClient } from "../../src/providers/detection";
import { getAdapterForClient } from "../../src/providers/index";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const clients: Array<{ close(): Promise<void> }> = [];

function controlPlane(allowed = true) {
  const checks: Record<string, unknown>[] = [];
  const confirms: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const order: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (path === "/api/v1/budgets/check") {
      order.push("check");
      checks.push(body);
      return Response.json({
        allowed,
        remaining_budget: allowed ? 100 : 0,
        reservation_id: allowed ? "res_native_media" : null,
        mode: allowed ? "alert_only" : "hard_deny",
        budget_limit: 100,
        current_usage: allowed ? 0 : 100,
        denied_by_period: allowed ? null : "monthly",
        project_id: `proj_${"0".repeat(24)}`,
        price_hints: null,
      });
    }
    if (path === "/api/v1/budgets/confirm") {
      order.push("confirm");
      confirms.push(body);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/v1/metadata/ingest" && Array.isArray(body)) {
      events.push(...body);
      return Response.json({ ingested: body.length, rejected: [] }, { status: 202 });
    }
    throw new Error("unexpected control-plane endpoint");
  };
  return { fetch, checks, confirms, events, order };
}

const leaves = [
  { path: "embeddings.create", modality: "embedding", endpoint: "/embeddings" },
  { path: "images.generate", modality: "image", endpoint: "/images/generations" },
  { path: "audio.speech.create", modality: "audio", endpoint: "/audio/speech" },
  { path: "audio.transcriptions.create", modality: "audio", endpoint: "/audio/transcriptions" },
] as const;

function request(path: string, marker: string): Record<string, unknown> {
  if (path === "embeddings.create") return { model: "embedding-test", input: [] };
  if (path === "images.generate") return { model: "image-test", prompt: "", n: 2 };
  if (path === "audio.speech.create") return { model: "speech-test", input: marker, voice: "test" };
  return { model: "whisper-test", file: new File([], "empty.wav"), response_format: "json" };
}

function invoke(client: object, path: string, params: Record<string, unknown>): unknown {
  const segments = path.split(".");
  const leaf = segments.pop();
  let resource = client;
  for (const segment of segments) resource = Reflect.get(resource, segment);
  const operation: unknown = Reflect.get(resource, leaf ?? "");
  if (typeof operation !== "function") throw new Error("missing native operation");
  return Reflect.apply(operation, resource, [params]);
}

function fixture(kind: "native" | "host", allowed: boolean, posture: "warn" | "raise") {
  const wire = controlPlane(allowed);
  const endpoints: string[] = [];
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // Stainless probes the injected fetch Response constructor before multipart upload.
    if (url.protocol === "data:") return new Response(null);
    const endpoint = url.pathname;
    endpoints.push(endpoint);
    wire.order.push("provider");
    if (endpoint.endsWith("/embeddings")) {
      return Response.json({ data: [], usage: { prompt_tokens: 42, total_tokens: 42 } });
    }
    if (endpoint.endsWith("/images/generations")) return Response.json({ data: [] });
    if (endpoint.endsWith("/audio/speech")) {
      return new Response(new Uint8Array(), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (endpoint.endsWith("/audio/transcriptions")) return Response.json({ text: "" });
    throw new Error("unexpected native provider endpoint");
  };
  const raw =
    kind === "native"
      ? new Together({ apiKey: "offline", fetch: providerFetch, maxRetries: 0 })
      : new OpenAI({
          apiKey: "offline",
          baseURL: "https://api.together.ai/v1",
          fetch: providerFetch,
          maxRetries: 0,
        });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const wrapped = new Solwyn(raw, {
    apiKey: API_KEY,
    fetch: wire.fetch,
    ...(posture === "raise" ? { onUnmetered: posture } : {}),
    reportUntrackedSurfaces: false,
    breakerReportingEnabled: false,
    logger,
  });
  clients.push(wrapped);
  return { raw, wrapped, wire, endpoints, logger };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  __resetUnmeteredSurfaceWarnings();
});

describe.each(["native", "host"] as const)("Together %s media admission", (kind) => {
  describe.each(["warn", "raise"] as const)("%s posture", (posture) => {
    it.each(leaves)("denies $path before native transport", async ({ path, modality }) => {
      const { wrapped, wire, endpoints } = fixture(kind, false, posture);
      await expect(
        Promise.resolve().then(() => invoke(wrapped, path, request(path, ""))),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      await wrapped.close();
      expect(endpoints).toHaveLength(0);
      expect(wire.checks).toHaveLength(1);
      expect(wire.checks[0]).toMatchObject({ provider: "together", modality });
      expect(wire.confirms).toHaveLength(0);
      expect(wire.events).toHaveLength(1);
      expect(wire.events[0]).toMatchObject({
        status: "budget_denied",
        provider: "together",
        modality,
      });
    });

    it.each(leaves)("tracks $path through its native serializer and media lifecycle", async ({
      path,
      modality,
      endpoint,
    }) => {
      const { wrapped, wire, endpoints, logger } = fixture(kind, true, posture);
      const marker = crypto.randomUUID();
      const report = coverage(wrapped);
      const matching = report.entries.filter((entry) => entry.surface === path);
      expect(matching.length).toBeGreaterThan(0);
      expect(
        matching.every((entry) => entry.kind === "metered" && entry.dispatchAction === "intercept"),
      ).toBe(true);
      const result = await invoke(wrapped, path, request(path, marker));
      if (path === "audio.speech.create") expect(result).toBeInstanceOf(Response);
      await wrapped.close();
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]?.endsWith(endpoint)).toBe(true);
      expect(wire.order.slice(0, 2)).toEqual(["check", "provider"]);
      expect(wire.checks).toHaveLength(1);
      expect(wire.checks[0]).toMatchObject({ provider: "together", modality });
      expect(wire.events).toHaveLength(1);
      expect(wire.events[0]).toMatchObject({
        status: "success",
        provider: "together",
        modality,
        is_model_fallback: false,
      });
      if (path === "audio.transcriptions.create") {
        expect(wire.confirms).toHaveLength(0);
        expect(wire.events[0]).not.toHaveProperty("token_details");
      } else {
        expect(wire.confirms).toHaveLength(1);
        expect(wire.confirms[0]).toMatchObject({
          provider: "together",
          modality,
          call_id: wire.events[0]?.["call_id"],
        });
        if (path === "embeddings.create") {
          expect(wire.events[0]).toMatchObject({ input_tokens: 42, output_tokens: 0 });
          expect(wire.confirms[0]?.["token_details"]).toMatchObject({
            input_tokens: 42,
            output_tokens: 0,
          });
          expect(wire.confirms[0]?.["token_details"]).not.toHaveProperty("is_estimated");
        } else {
          const media =
            path === "images.generate" ? { image_count: 2 } : { input_characters: marker.length };
          expect(wire.confirms[0]?.["media_usage"]).toMatchObject(media);
          expect(wire.events[0]?.["media_usage"]).toMatchObject(media);
          expect(wire.events[0]).not.toHaveProperty("token_details");
        }
      }
      expect(
        JSON.stringify([wire.checks, wire.confirms, wire.events, logger.warn.mock.calls]).includes(
          marker,
        ),
      ).toBe(false);
      expect(
        logger.warn.mock.calls.some(([message]) => String(message).includes("untracked surface")),
      ).toBe(false);
    });
  });
});

it("preserves native Together video refusal and deliberately unwired surfaces", async () => {
  const { wrapped, wire, endpoints } = fixture("native", true, "raise");
  expect(
    coverage(wrapped).entries.find((entry) => entry.surface === "audio.translations"),
  ).toMatchObject({ kind: "unmetered_spend", capabilityScope: "resource" });
  expect(() => Reflect.get(Reflect.get(wrapped, "audio"), "translations")).toThrow(
    UntrackedSpendSurfaceError,
  );
  await expect(
    Promise.resolve().then(() => invoke(wrapped, "videos.create", { model: "video-test" })),
  ).rejects.toBeInstanceOf(UnsupportedSurfaceError);
  for (const path of ["completions", "rerank", "codeInterpreter", "evals"]) {
    expect(() => Reflect.get(wrapped, path)).toThrow(UntrackedSpendSurfaceError);
  }
  expect(wire.checks).toHaveLength(0);
  expect(endpoints).toHaveLength(0);
});

class InstrumentedRuntimeClient extends BedrockRuntimeClient {}
class WrappedInstrumentedRuntimeClient extends InstrumentedRuntimeClient {}

describe("Bedrock native constructor ancestry", () => {
  it.each([
    BedrockRuntimeClient,
    InstrumentedRuntimeClient,
    WrappedInstrumentedRuntimeClient,
  ])("meters %s with actual AWS command serialization", async (Client) => {
    const wire = controlPlane();
    let dispatches = 0;
    const raw = new Client({
      region: "us-east-1",
      credentials: { accessKeyId: "offline", secretAccessKey: "offline" },
      requestHandler: {
        handle: async () => {
          dispatches += 1;
          wire.order.push("provider");
          return {
            response: {
              statusCode: 200,
              headers: {},
              body: new TextEncoder().encode(
                JSON.stringify({
                  usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
                  stopReason: "end_turn",
                  metrics: { latencyMs: 1 },
                }),
              ),
            },
          };
        },
      },
    });
    expect(raw instanceof BedrockRuntimeClient).toBe(true);
    expect(detectBedrockClient(raw)).toBe(true);
    expect((await getAdapterForClient(raw)).name).toBe("bedrock");
    const wrapped = new Solwyn(raw, {
      apiKey: API_KEY,
      fetch: wire.fetch,
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
    });
    clients.push(wrapped);
    expect(coverage(wrapped).providerChain[0]).toMatchObject({
      provider: "bedrock",
      clientShape: "bedrock_v3",
    });
    await wrapped.send(new ConverseCommand({ modelId: "anthropic.claude-test", messages: [] }));
    await wrapped.close();
    raw.destroy();
    expect(dispatches).toBe(1);
    expect(wire.order.slice(0, 2)).toEqual(["check", "provider"]);
    expect(wire.confirms).toHaveLength(1);
    expect(wire.events[0]).toMatchObject({
      provider: "bedrock",
      input_tokens: 30,
      output_tokens: 20,
    });
  });

  it("accepts an explicit instrumentation pin without invoking diagnostic getters", async () => {
    const raw = new InstrumentedRuntimeClient({ region: "us-east-1" });
    let reads = 0;
    Object.defineProperty(raw, "constructor", {
      configurable: true,
      get() {
        reads += 1;
        throw new Error("getter must remain inert");
      },
    });
    const wrapped = new Solwyn(raw, {
      apiKey: API_KEY,
      provider: "bedrock",
      reportUntrackedSurfaces: false,
    });
    clients.push(wrapped);
    expect(reads).toBe(0);
    await wrapped.close();
    raw.destroy();
  });

  it("rejects unrelated AWS/control-plane names and contains hostile reflection", () => {
    class BedrockClient {
      send() {}
      config = {};
      middlewareStack = {};
    }
    class S3Client {
      send() {}
      config = {};
      middlewareStack = {};
    }
    for (const raw of [
      new BedrockClient(),
      new S3Client(),
      { meta: { service_model: { service_name: "bedrock" } } },
    ]) {
      expect(detectBedrockClient(raw)).toBe(false);
      expect(() => new Solwyn(raw, { apiKey: API_KEY })).toThrow(ConfigurationError);
    }
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          throw new Error("opaque reflection failure");
        },
      },
    );
    expect(detectBedrockClient(hostile)).toBe(false);
    expect(traps).toBeLessThan(10);
    const cycle: object = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          return cycle;
        },
      },
    );
    expect(detectBedrockClient(cycle)).toBe(false);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(detectBedrockClient(revoked.proxy)).toBe(false);
  });
});
