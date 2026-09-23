import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";

let probe: { status: number | null; stderr: string; report: Record<string, unknown> };

beforeAll(() => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/stream-terminal-retention.mts"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  probe = {
    status: result.status,
    stderr: result.stderr,
    report: result.status === 0 ? JSON.parse(result.stdout) : {},
  };
}, 35_000);

it("releases terminal stream ownership while preserving active streams and cached Responses", () => {
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.report).toMatchObject({ ok: true, active_stream: true });
});

it("held wrapped streams keep no consumed payload reachable on any termination path", () => {
  expect(probe.status, probe.stderr).toBe(0);
  // Alive counts out of 8 held handles per path.
  expect(probe.report["payload_retention"]).toEqual({
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
  expect(probe.status, probe.stderr).toBe(0);
  // Alive request objects out of 10 held, never-iterated streams per surface.
  expect(probe.report["request_retention"]).toEqual({ chat: 0, responses: 0, google: 0 });
});
