/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { run, Solwyn } from "../../src/node";
import { FakeControlPlane } from "../../src/testing/index";

const supportUrl = new URL("../../scripts/verification/live-support.mjs", import.meta.url).href;

describe("live integration support (offline)", () => {
  it("rejects a request outside the selected control plane before invoking its transport", async () => {
    const { captureControlPlane } = await import(supportUrl);
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const wire = captureControlPlane("https://control.invalid/base", transport);
    await expect(wire.fetch("https://provider.invalid/api/v1/metadata/ingest")).rejects.toThrow(
      "request escaped the selected control plane",
    );
    await expect(wire.fetch("https://control.invalid/other/api/v1/budgets/check")).rejects.toThrow(
      "request escaped the control-plane API",
    );
    expect(transport).not.toHaveBeenCalled();
    expect(wire.pending).toBe(0);
  });

  it("preserves the original response and signal without recording credentials", async () => {
    const { captureControlPlane } = await import(supportUrl);
    const response = Response.json({ ingested: 1, rejected: [], duplicates: [] }, { status: 202 });
    const transport = vi.fn(async () => response);
    const wire = captureControlPlane("https://control.invalid", transport);
    const controller = new AbortController();
    const init = {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-credential" },
      body: JSON.stringify([{ call_id: "synthetic-call" }]),
      signal: controller.signal,
    };
    const returned = await wire.fetch("https://control.invalid/api/v1/metadata/ingest", init);
    expect(returned).toBe(response);
    expect(await returned.json()).toEqual({ ingested: 1, rejected: [], duplicates: [] });
    expect(transport).toHaveBeenCalledWith("https://control.invalid/api/v1/metadata/ingest", init);
    expect(JSON.stringify(wire.exchanges)).not.toContain("synthetic-credential");
    expect(wire.pending).toBe(0);
  });

  it.each([
    "openai",
    "anthropic",
    "google",
    "bedrock",
  ])("runs both %s fixture shapes through the real SDK without network access", async (provider) => {
    const { assertDelivery, captureControlPlane, consume, metadata, providerFixture } =
      await import(supportUrl);
    const plane = new FakeControlPlane();
    const wire = captureControlPlane(plane.apiUrl, plane.fetch);
    const fixture = providerFixture(provider);
    const client = new Solwyn(fixture.raw, {
      apiKey: plane.apiKey,
      apiUrl: plane.apiUrl,
      fetch: wire.fetch,
      provider,
      tags: {},
      budgetCheckCacheTtl: 0,
    });
    try {
      await run("synthetic-live-fixture", { tags: { suite: "offline" } }, async () => {
        await fixture.invoke(client);
        await consume(await fixture.invoke(client, true));
      });
    } finally {
      await client.close();
    }
    assertDelivery(wire);
    expect(fixture.calls).toBe(2);
    expect(fixture.ended).toBe(1);
    expect(fixture.closed).toBe(true);
    expect(metadata(wire)).toHaveLength(2);
    for (const event of metadata(wire)) {
      expect(event).toMatchObject({ provider, input_tokens: 1000, output_tokens: 500 });
      expect(event.token_details.is_estimated).toBeUndefined();
    }
  });
});
