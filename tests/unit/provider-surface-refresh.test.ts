import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI, { AzureOpenAI } from "openai";
import Together from "together-ai";
import { describe, expect, it } from "vitest";
import { coverage, noopLogger, Solwyn, UntrackedSpendSurfaceError } from "../../src/index";
import { resolveSurfaceRule, type SurfaceContext } from "../../src/surfaces";
import { FakeControlPlane } from "../../src/testing";
import { installOfflineGuard } from "../helpers/offline-guard";

const OPENAI_GAPS = [
  "responsePromise",
  "parseResponseWithTimeout",
  "audio.voices.create",
  "beta.agents.environments.create",
  "beta.agents.environments.files.create",
  "beta.agents.environments.files.prepare",
  "beta.agents.environments.files.upload",
  "beta.agents.sessions.create",
  "beta.agents.sessions.stream",
  "beta.agents.sessions.events.create",
  "beta.agents.sessions.events.stream",
  "beta.responses.create",
  "beta.responses.compact",
  "beta.responses.retrieve",
  "contentProvenanceChecks.create",
  "decisions.create",
  "live.create",
  "live.sessions.accept",
  "live.sessions.fork",
  "realtime.calls.create",
  "realtime.translations.clientSecrets.create",
] as const;

const TOGETHER_GAPS = [
  "beta.jig.rollback",
  "clusters.create",
  "clusters.update",
  "clusters.remediations.create",
  "clusters.remediations.approve",
  "clusters.storage.create",
  "clusters.storage.update",
] as const;

const GOOGLE_GAPS = [
  "models.generateContentWithContinuation",
  "models.generateContentStreamWithContinuation",
  "chats.modelsModule.generateContentWithContinuation",
  "chats.modelsModule.generateContentStreamWithContinuation",
  "voices.create",
  "voices.getClient",
  "voices.parentClient.apiCall",
  "voices.parentClient.request",
  "voices.parentClient.requestStream",
  "voices.parentClient.streamApiCall",
  "voices.parentClient.unaryApiCall",
  "voices.parentClient.fetchUploadUrl",
  "voices.parentClient.uploadFile",
  "voices.parentClient.uploadFileToFileSearchStore",
] as const;

const GOOGLE_FETCH_PARENTS = [
  "apiClient",
  "authTokens.apiClient",
  "batches.apiClient",
  "caches.apiClient",
  "chats.apiClient",
  "chats.modelsModule.apiClient",
  "fileSearchStores.apiClient",
  "fileSearchStores.documents.apiClient",
  "files.apiClient",
  "live.apiClient",
  "live.music.apiClient",
  "models.apiClient",
  "operations.apiClient",
  "tunings.apiClient",
  "voices.parentClient",
] as const;

const families = [
  { name: "openai", build: () => new OpenAI({ apiKey: "offline" }), paths: OPENAI_GAPS },
  {
    name: "azure",
    build: () =>
      new AzureOpenAI({
        apiKey: "offline",
        endpoint: "https://offline.invalid",
        apiVersion: "2024-06-01",
      }),
    paths: OPENAI_GAPS,
  },
  {
    name: "anthropic",
    build: () => new Anthropic({ apiKey: "offline" }),
    paths: ["makeTracedRequest"],
  },
  {
    name: "together",
    build: () => new Together({ apiKey: "offline" }),
    paths: TOGETHER_GAPS,
  },
  {
    name: "google",
    build: () => new GoogleGenAI({ apiKey: "offline" }),
    paths: [...GOOGLE_GAPS, ...GOOGLE_FETCH_PARENTS.map((parent) => `${parent}.getFetch`)],
  },
] as const;

describe.each(families)("reviewed $name coverage gaps", ({ build, paths }) => {
  it("classifies each gap and refuses it before provider or budget I/O in strict mode", async () => {
    const guard = installOfflineGuard();
    const attempts = guard.socketAttempts();
    const plane = new FakeControlPlane();
    const client = new Solwyn(build(), {
      apiKey: plane.apiKey,
      apiUrl: plane.apiUrl,
      fetch: plane.fetch,
      logger: noopLogger,
      onUnmetered: "raise",
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
    });
    try {
      const entries = coverage(client).entries;
      for (const path of paths) {
        expect(
          entries.find((entry) => entry.surface === path),
          path,
        ).toMatchObject({
          kind: "unmetered_spend",
          token: path,
        });
        expect(() => {
          let current: object = client;
          for (const segment of path.split(".")) current = Reflect.get(current, segment);
          if (typeof current === "function") Reflect.apply(current, undefined, []);
        }, path).toThrow(UntrackedSpendSurfaceError);
      }
    } finally {
      await client.close();
    }
    expect(plane.checks).toEqual([]);
    expect(plane.confirms).toEqual([]);
    expect(plane.ingested).toEqual([]);
    expect(guard.socketAttempts() - attempts).toBe(0);
  });
});

it("keeps Anthropic organization traversal distinct from scalar OpenAI attribution", () => {
  const contexts: SurfaceContext[] = [
    { provider: "anthropic", dialect: "anthropic", clientShape: "anthropic_sdk" },
    { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
  ];
  expect(
    contexts.map(
      (context) => resolveSurfaceRule({ context, path: "organization", source: "raw" })?.kind,
    ),
  ).toEqual(["namespace", "metadata"]);
});

it.each([
  false,
  true,
])("settles cumulative Google continuation usage once (stream=%s)", async (streaming) => {
  const plane = new FakeControlPlane();
  let requests = 0;
  const providerFetch: typeof fetch = async () => {
    const first = requests++ === 0;
    if (requests > 2) throw new Error("unexpected continuation request");
    const response = {
      candidates: [
        {
          index: 0,
          content: { role: "model", parts: [] },
          finishReason: first ? "CONTINUATION" : "STOP",
          ...(first ? { continuationToken: "synthetic-checkpoint" } : {}),
        },
      ],
      usageMetadata: {
        promptTokenCount: first ? 10 : 14,
        candidatesTokenCount: first ? 3 : 5,
        thoughtsTokenCount: first ? 2 : 1,
        cachedContentTokenCount: first ? 4 : 6,
        toolUsePromptTokenCount: first ? 1 : 2,
      },
    };
    return streaming
      ? new Response(`data: ${JSON.stringify(response)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(response);
  };
  const client = new Solwyn(
    new GoogleGenAI({ apiKey: "offline", httpOptions: { fetch: providerFetch } }),
    {
      apiKey: plane.apiKey,
      apiUrl: plane.apiUrl,
      fetch: plane.fetch,
      logger: noopLogger,
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
    },
  );
  try {
    const params = { model: "gemini-test", contents: [{ role: "user", parts: [] }] };
    if (streaming) {
      for await (const _chunk of await client.models.generateContentStream(params)) {
        // Exhaust both native continuation hops so terminal usage settles.
      }
    } else {
      await client.models.generateContent(params);
    }
  } finally {
    await client.close();
  }
  expect(requests).toBe(2);
  expect(plane.checks).toHaveLength(1);
  expect(plane.confirms).toHaveLength(1);
  expect(plane.confirms[0]).toMatchObject({
    token_details: {
      input_tokens: 24,
      output_tokens: 11,
      cached_input_tokens: 10,
      reasoning_tokens: 3,
      tool_use_input_tokens: 3,
    },
  });
  expect(plane.confirms[0]?.token_details.is_estimated).toBe(false);
});

it("meters native Responses parsing with an unbranded JSON schema", async () => {
  const plane = new FakeControlPlane();
  let requests = 0;
  const raw = new OpenAI({
    apiKey: "offline",
    maxRetries: 0,
    fetch: async () => {
      requests += 1;
      return Response.json({
        id: "resp_synthetic",
        object: "response",
        status: "completed",
        model: "gpt-test",
        output: [
          {
            id: "msg_synthetic",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: '{"count":3}', annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      });
    },
  });
  const client = new Solwyn(raw, {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    logger: noopLogger,
    leaseEnabled: false,
    reportUntrackedSurfaces: false,
    breakerReportingEnabled: false,
  });
  try {
    const result = await client.responses.parse({
      model: "gpt-test",
      text: { format: { type: "json_schema", name: "counter", schema: { type: "object" } } },
    });
    expect(result.output_parsed).toEqual({ count: 3 });
  } finally {
    await client.close();
  }
  expect(requests).toBe(1);
  expect(plane.checks).toHaveLength(1);
  expect(plane.confirms).toHaveLength(1);
  expect(plane.confirms[0]?.token_details).toMatchObject({
    input_tokens: 10,
    output_tokens: 4,
    cached_input_tokens: 2,
    reasoning_tokens: 1,
    is_estimated: false,
  });
});
