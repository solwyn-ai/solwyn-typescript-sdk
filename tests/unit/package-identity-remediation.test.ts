import { describe, expect, it, vi } from "vitest";

describe("duplicate package module identity", () => {
  it("shares callback and detached run frames across independently evaluated Node entries", async () => {
    const first = await import("../../src/node");
    vi.resetModules();
    const second = await import("../../src/node");
    for (const [owner, reader] of [
      [first, second],
      [second, first],
    ] as const) {
      await owner.run("outer", { tags: { scope: "shared" } }, async () => {
        await Promise.resolve();
        expect(reader.currentRunContext()).toEqual(owner.currentRunContext());
        expect(reader.getCurrentRun()?.agentRunId).toBe(owner.currentRun()?.agentRunId);
        const handle = reader.createRun("detached");
        await handle.activate(async () => {
          await Promise.resolve();
          expect(owner.currentRun()?.agentRunId).toBe(handle.runId);
          expect(owner.currentRunContext().tags).toEqual({ scope: "shared" });
        });
        handle.finish();
      });
    }
  });

  it("shares wrapper brands without trusting provider-visible properties", async () => {
    const first = await import("../../src/registry");
    vi.resetModules();
    const second = await import("../../src/registry");
    const wrapper = {};
    first.brandSolwynWrapper(wrapper);
    expect(second.isSolwynWrapper(wrapper)).toBe(true);
    expect(() => second.assertRawProviderClient(wrapper)).toThrow();
    expect(second.isSolwynWrapper({ __solwyn: true })).toBe(false);
  });
});
