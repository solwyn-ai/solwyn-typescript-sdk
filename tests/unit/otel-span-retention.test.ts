import { describe, expect, it } from "vitest";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

// The probe runs in its own `node --expose-gc` subprocess so forced collection is real. On
// Node 22, AsyncLocalStorage stores the active context on every promise, so a memoized
// lifecycle promise created on a caller's path would keep that caller's span alive.
describe("caller spans are not retained by a reachable client", () => {
  it(
    "releases the initializing call's span and the closing caller's span",
    async () => {
      const result = JSON.parse(await runGcProbe("otel-span-retention")) as Record<string, unknown>;
      expect(result).toEqual({
        creates: 3,
        initializingReleased: true,
        closingReleased: true,
        ingested: 3,
      });
    },
    gcProbeTimeout,
  );
});
