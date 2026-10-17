import { beforeAll, expect, it } from "vitest";
import { gcProbeTimeout, runGcProbe } from "../helpers/gc-probe";

let report: Record<string, unknown>;

beforeAll(async () => {
  report = JSON.parse(await runGcProbe("stream-terminal-retention"));
}, gcProbeTimeout);

it("releases terminal stream ownership while preserving active streams and cached Responses", () => {
  expect(report).toMatchObject({ ok: true, active_stream: true });
});

it("held wrapped streams keep no consumed payload reachable on any termination path", () => {
  // Alive counts out of 8 held handles per path.
  expect(report["payload_retention"]).toEqual({
    responses_exhausted: { output: 0, tools: 0 },
    responses_early_closed: { output: 0, tools: 0 },
    responses_errored: { output: 0, tools: 0 },
    chat_exhausted: { choices: 0 },
    chat_early_closed: { choices: 0 },
    google_exhausted: { first_candidates: 0 },
    google_early_closed: { first_candidates: 0 },
    google_closed_before_first_iteration: { first_candidates: 0 },
    google_errored: { first_candidates: 0 },
    google_mid_stream: { first_candidates: 0 },
  });
});

it("held unfinished wrapped streams keep no request reachable", () => {
  // Alive request objects out of 10 held, never-iterated streams per surface.
  expect(report["request_retention"]).toEqual({ chat: 0, responses: 0, google: 0 });
});
