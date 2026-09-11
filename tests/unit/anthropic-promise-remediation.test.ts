import Anthropic from "@anthropic-ai/sdk";
import { expect, it, vi } from "vitest";
import { noopLogger, Solwyn } from "../../src/index";
import { FakeControlPlane } from "../../src/testing";

it("returns an honest plain promise while native Anthropic success settles once", async () => {
  const plane = new FakeControlPlane();
  const providerFetch = vi.fn(async () =>
    Response.json({
      id: "msg_review",
      type: "message",
      role: "assistant",
      model: "claude-review",
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 3 },
    }),
  );
  const native = new Anthropic({ apiKey: "synthetic", maxRetries: 0, fetch: providerFetch });
  const wrapped = new Solwyn(native, {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    provider: "anthropic",
    leaseEnabled: false,
    reportUntrackedSurfaces: false,
    logger: noopLogger,
  });
  const pending = wrapped.messages.create({ model: "claude-review", messages: [], max_tokens: 1 });
  expect(pending).toBeInstanceOf(Promise);
  expect(pending).not.toHaveProperty("withResponse");
  expect(pending).not.toHaveProperty("asResponse");
  expect((await pending).usage).toMatchObject({ input_tokens: 2, output_tokens: 3 });
  await wrapped.close();
  expect(providerFetch).toHaveBeenCalledTimes(1);
  expect(plane.checks).toHaveLength(1);
  expect(plane.confirms).toHaveLength(1);
  expect(plane.ingested).toHaveLength(1);
});
