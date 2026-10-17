import { expect, it } from "vitest";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

it(
  "releases abandoned handles by finalizer and fences a late finalizer after a reset",
  async () => {
    const stdout = await runGcProbe("run-control-finalizer");
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  },
  gcProbeTimeout,
);
