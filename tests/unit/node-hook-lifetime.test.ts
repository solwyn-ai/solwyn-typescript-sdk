import { expect, it } from "vitest";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

it(
  "tracks promises only while callback or detached run lifetimes are live",
  async () => {
    const stdout = await runGcProbe("node-hook-lifetime");
    expect(JSON.parse(stdout)).toEqual({ idle: true, concurrent: true, detached: true });
  },
  gcProbeTimeout,
);
