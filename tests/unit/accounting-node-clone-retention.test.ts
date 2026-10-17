import { expect, it } from "vitest";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

it(
  "separates process-cached clone resources from live user MessageChannels",
  async () => {
    const stdout = await runGcProbe("accounting-node-clone-retention");
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, user_message_channel: true });
  },
  gcProbeTimeout,
);
