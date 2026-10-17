import { afterEach, expect, it, vi } from "vitest";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { buildRuntimes } from "../../src/registry";
import type { FetchLike } from "../../src/transport";

afterEach(() => vi.restoreAllMocks());

it("routes adapter warnings and detection info to each runtime's logger", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  const loggers = [0, 1].map(() => ({ ...noopLogger, warn: vi.fn(), info: vi.fn() }));
  for (const logger of loggers) {
    const [compat] = await buildRuntimes(
      {
        baseURL: "http://localhost:1234/v1",
        chat: { completions: { create() {} } },
      },
      "synthetic-model",
      [],
      { logger },
    );
    if (!compat) throw new Error("missing runtime");
    compat.adapter.estimateMissingUsage({}, { estimatedInputTokens: 10 });
    compat.adapter.estimateMissingUsage({}, { estimatedInputTokens: 10 });
    compat.adapter.extractServiceTier({ service_tier: "x".repeat(50) });
    const [anthropic] = await buildRuntimes({ messages: { create() {} } }, "claude-test", [], {
      logger,
    });
    const acc = anthropic?.adapter.createStreamAccumulator();
    acc?.observe({ type: "message_start", message: { usage: { input_tokens: 1 } } });
    acc?.finalize();
    class BedrockRuntimeClient {
      send() {}
    }
    const [bedrock] = await buildRuntimes(new BedrockRuntimeClient(), "synthetic-model", [], {
      primaryProvider: "bedrock",
      logger,
    });
    const bedrockAcc = bedrock?.adapter.createStreamAccumulator();
    bedrockAcc?.observe({ metadata: {} });
    bedrockAcc?.finalize();
    expect(logger.warn.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("returned no token usage"),
        expect.stringContaining("service_tier exceeds"),
        expect.stringContaining("without message_delta"),
        expect.stringContaining("zero tokens"),
      ]),
    );
    expect(
      logger.warn.mock.calls.filter(([message]) => message.includes("returned no token usage")),
    ).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  }
  expect(consoleWarn).not.toHaveBeenCalled();
  expect(consoleInfo).not.toHaveBeenCalled();
});

it("passes the Solwyn logger to adapters on lazy initialization", async () => {
  const warn = vi.fn();
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/budgets/check"))
      return Response.json({
        allowed: true,
        remaining_budget: 100,
        reservation_id: "res_test",
        mode: "alert_only",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: null,
        project_id: `proj_${"0".repeat(24)}`,
        price_hints: null,
      });
    if (url.endsWith("/metadata/ingest"))
      return Response.json(
        {
          ingested: JSON.parse(String(init?.body)).length,
          rejected: [],
          duplicates: [],
        },
        { status: 202 },
      );
    return new Response(null, { status: 204 });
  };
  const wrapped = new Solwyn(
    {
      baseURL: "https://example.test/v1",
      chat: { completions: { create: async (_params: unknown) => ({}) } },
    },
    {
      apiKey: `sk_proj_${"a".repeat(64)}`,
      provider: "openai_compatible",
      fetch,
      leaseEnabled: false,
      breakerReportingEnabled: false,
      logger: { ...noopLogger, warn },
    },
  );
  try {
    await wrapped.chat.completions.create({ model: "synthetic-model", messages: [] });
    expect(warn.mock.calls.some(([message]) => message.includes("returned no token usage"))).toBe(
      true,
    );
    expect(consoleWarn).not.toHaveBeenCalled();
  } finally {
    await wrapped.close();
  }
  expect(warn.mock.calls.some(([message]) => message.includes("reporter.ingest_response_"))).toBe(
    false,
  );
});
