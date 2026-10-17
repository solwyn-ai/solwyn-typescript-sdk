import { expect, it } from "vitest";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

it(
  "finalizes abandoned streams, collects unclosed clients, and releases run and probe ownership",
  async () => {
    const stdout = await runGcProbe("abandoned-stream-retention");
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      abandoned: 10,
      unclosed_abandoned: 10,
      probe_released: true,
    });
  },
  gcProbeTimeout,
);
