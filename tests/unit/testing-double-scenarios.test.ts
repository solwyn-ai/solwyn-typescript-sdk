import { describe, expect, it, vi } from "vitest";
import { FakeControlPlane } from "../../src/testing/index";

const CHECK_PATH = "/api/v1/budgets/check";
const INGEST_PATH = "/api/v1/metadata/ingest";

function checkBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { estimated_input_tokens: 10, model: "gpt-4o", provider: "openai", ...overrides };
}

function event(index: number): Record<string, unknown> {
  const id = String(index).padStart(8, "0");
  return {
    model: `model-${index}`,
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: `${id}-1111-1111-1111-111111111111`,
    sdk_instance_id: "sdk-1",
    timestamp: `2026-08-31T01:00:${String(index).padStart(2, "0")}Z`,
  };
}

function confirmBody(
  reservationId: string,
  callId = "11111111-1111-1111-1111-111111111111",
): Record<string, unknown> {
  return {
    reservation_id: reservationId,
    model: "gpt-4o",
    provider: "openai",
    call_id: callId,
    token_details: {
      input_tokens: 1,
      output_tokens: 1,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
    },
  };
}

async function post(
  plane: FakeControlPlane,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return plane.fetch(`${plane.apiUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

describe("FakeControlPlane scenario windows", () => {
  it("rejects invalid counts, delays, refusal statuses, and ingest scripts", () => {
    const plane = new FakeControlPlane();
    const invalidRejectionCode = () =>
      plane.rejectIngest({ count: 1, code: "not-a-rejection-code" as never });
    for (const create of [
      () => plane.outage({ requests: -1 }),
      () => plane.slow(-0.1),
      () => plane.slow(0, { requests: -1 }),
      () => plane.readOnly({ requests: -1 }),
      () => plane.refuseChecks({ status: 500 as never }),
      () => plane.refuseChecks({ retryAfter: -1 }),
      () => plane.rejectIngest({}),
      () => plane.rejectIngest({ indices: [], count: 1 }),
      () => plane.rejectIngest({ indices: [] }),
      () => plane.rejectIngest({ indices: [0, 0] }),
      () => plane.rejectIngest({ count: 0 }),
      invalidRejectionCode,
      () => plane.rejectIngest({ malformed: true, requests: -1 }),
    ]) {
      expect(create).toThrow(/^solwyn\.testing:/);
    }
    expect(invalidRejectionCode).toThrow(
      "solwyn.testing: unknown ingest rejection code 'not-a-rejection-code'",
    );
  });

  it("tracks nested identical windows by identity and makes end/dispose idempotent", async () => {
    const plane = new FakeControlPlane();
    const first = plane.outage({ requests: 1, path: CHECK_PATH });
    const second = plane.outage({ requests: 1, path: CHECK_PATH });
    first.end();
    first.end();
    first[Symbol.dispose]();

    await expect(post(plane, CHECK_PATH, checkBody())).rejects.toEqual(
      new TypeError("fetch failed"),
    );
    second.end();
    expect((await post(plane, CHECK_PATH, checkBody())).status).toBe(200);
  });

  it("defaults slow() to the confirm endpoint", async () => {
    const plane = new FakeControlPlane();
    const slow = plane.slow(60, { requests: 1 });
    const controller = new AbortController();
    controller.abort();
    expect((await post(plane, CHECK_PATH, checkBody(), controller.signal)).status).toBe(200);

    await expect(
      post(
        plane,
        "/api/v1/budgets/confirm",
        {
          reservation_id: "res_fake_00000001",
          model: "gpt-4o",
          provider: "openai",
          call_id: "11111111-1111-1111-1111-111111111111",
          token_details: {
            input_tokens: 1,
            output_tokens: 1,
            cached_input_tokens: 0,
            reasoning_tokens: 0,
            audio_input_tokens: 0,
            audio_output_tokens: 0,
          },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(plane.confirms).toHaveLength(1);
    slow.end();
  });

  it("honors a pre-aborted signal for a matched zero-second slow after committing state", async () => {
    const plane = new FakeControlPlane();
    const slow = plane.slow(0, { path: CHECK_PATH, requests: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(post(plane, CHECK_PATH, checkBody(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(plane.checks).toHaveLength(1);
    slow.end();
  });

  it("gives outage precedence without consuming slow/refusal/read-only counts", async () => {
    const delayedPlane = new FakeControlPlane();
    const slow = delayedPlane.slow(60, { requests: 1, path: CHECK_PATH });
    const outage = delayedPlane.outage({ requests: 1, path: CHECK_PATH });
    await expect(post(delayedPlane, CHECK_PATH, checkBody())).rejects.toThrow("fetch failed");
    expect(delayedPlane.checks).toEqual([]);

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      post(delayedPlane, CHECK_PATH, checkBody(), preAborted.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(delayedPlane.checks).toHaveLength(1);
    slow.end();
    outage.end();

    const refusalPlane = new FakeControlPlane();
    const refusal = refusalPlane.refuseChecks({ status: 503, requests: 1 });
    const readOnly = refusalPlane.readOnly({ requests: 1, path: CHECK_PATH });
    const secondOutage = refusalPlane.outage({ requests: 1, path: CHECK_PATH });
    await expect(post(refusalPlane, CHECK_PATH, checkBody())).rejects.toThrow("fetch failed");
    expect((await post(refusalPlane, CHECK_PATH, checkBody())).status).toBe(503);
    expect((await post(refusalPlane, CHECK_PATH, checkBody())).status).toBe(403);
    expect((await post(refusalPlane, CHECK_PATH, checkBody())).status).toBe(200);
    refusal.end();
    readOnly.end();
    secondOutage.end();
  });

  it("does not consume a path-scoped scenario on a nonmatching route", async () => {
    const plane = new FakeControlPlane();
    const outage = plane.outage({ requests: 1, path: CHECK_PATH });
    expect((await post(plane, INGEST_PATH, [event(90)])).status).toBe(202);
    await expect(post(plane, CHECK_PATH, checkBody())).rejects.toThrow("fetch failed");
    expect((await post(plane, CHECK_PATH, checkBody())).status).toBe(200);
    outage.end();
  });

  it("lets a syntactically valid invalid check body consume a refusal, but not malformed JSON", async () => {
    const plane = new FakeControlPlane();
    const refusal = plane.refuseChecks({ status: 503, requests: 1 });
    const malformedJson = await plane.fetch(`${plane.apiUrl}${CHECK_PATH}`, {
      method: "POST",
      body: '{"private_prompt":"secret"',
    });
    expect(malformedJson.status).toBe(422);
    expect(await malformedJson.text()).not.toContain("secret");
    expect((await post(plane, CHECK_PATH, { private_prompt: "secret" })).status).toBe(503);
    expect((await post(plane, CHECK_PATH, checkBody())).status).toBe(200);
    refusal.end();
  });

  it("applies direct-handle endpoint scenarios without spending transport windows", async () => {
    vi.useFakeTimers();
    try {
      const plane = new FakeControlPlane();
      const slow = plane.slow(1, { path: CHECK_PATH, requests: 1 });
      const outage = plane.outage({ path: CHECK_PATH, requests: 1 });
      const refusal = plane.refuseChecks({ status: 503, requests: 1 });
      expect(plane.handle("POST", CHECK_PATH, { private_prompt: "secret" })).toEqual({
        status: 503,
        body: { detail: "Budget backend temporarily unavailable; retry" },
        headers: {},
      });
      const readOnly = plane.readOnly({ path: CHECK_PATH, requests: 1 });
      expect(plane.handle("POST", CHECK_PATH, { private_prompt: "secret" })).toEqual({
        status: 403,
        body: { detail: { code: "read_only_key", message: "read-only project key cannot write" } },
        headers: {},
      });
      await expect(post(plane, CHECK_PATH, checkBody())).rejects.toThrow("fetch failed");
      const delayed = post(plane, CHECK_PATH, checkBody());
      await vi.advanceTimersByTimeAsync(1000);
      expect((await delayed).status).toBe(200);
      slow.end();
      outage.end();
      refusal.end();
      readOnly.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves an unknown route before read-only and does not consume the window", async () => {
    const plane = new FakeControlPlane();
    const readOnly = plane.readOnly({ requests: 1 });
    expect((await post(plane, "/api/v1/not-real", {})).status).toBe(404);
    expect(plane.unmatchedRequests).toEqual([{ method: "POST", path: "/api/v1/not-real" }]);
    const refusal = await post(plane, CHECK_PATH, checkBody());
    expect(refusal.status).toBe(403);
    expect(await refusal.json()).toEqual({
      detail: { code: "read_only_key", message: "read-only project key cannot write" },
    });
    readOnly.end();
    expect(
      (
        await plane.fetch(`${plane.apiUrl}${CHECK_PATH}?ignored=query`, {
          method: "POST",
          body: JSON.stringify(checkBody()),
        })
      ).status,
    ).toBe(200);
  });

  it("emits exact check refusals and real Retry-After headers", async () => {
    const cases = [
      { status: 422 as const, expected: 422 },
      { status: 429 as const, expected: 429 },
      { status: 503 as const, expected: 503 },
    ];
    for (const { status, expected } of cases) {
      const plane = new FakeControlPlane();
      const window = plane.refuseChecks({ status, requests: 1, retryAfter: 17 });
      const response = await post(plane, CHECK_PATH, checkBody({ model: "a".repeat(60) }));
      expect(response.status).toBe(expected);
      const body = (await response.json()) as Record<string, unknown>;
      if (status === 422) {
        const model = "a".repeat(50);
        expect(body).toEqual({
          detail: {
            code: "unknown_model",
            model,
            provider: "openai",
            message: `Solwyn does not have pricing for model '${model}'. File an issue at https://github.com/solwyn-ai/solwyn-python-sdk/issues or contact support — we typically add new models within 24h.`,
          },
        });
      } else if (status === 429) {
        expect(body).toEqual({ detail: "Rate limit exceeded", retry_after: 17 });
        expect(response.headers.get("Retry-After")).toBe("17");
      } else {
        expect(body).toEqual({ detail: "Budget backend temporarily unavailable; retry" });
      }
      if (status !== 429) expect(response.headers.get("Retry-After")).toBeNull();
      expect(plane.checks).toEqual([]);
      window.end();
    }
  });

  it("snapshots verdict and state before delay in both denial-race directions", async () => {
    const plane = new FakeControlPlane();
    const slow = plane.slow(0.01, { path: CHECK_PATH, requests: 2 });
    plane.denyNext();
    const deniedPromise = post(plane, CHECK_PATH, checkBody());
    plane.clearDenials();
    await expect((await deniedPromise).json()).resolves.toMatchObject({ allowed: false });

    const allowedPromise = post(plane, CHECK_PATH, checkBody());
    plane.denyNext();
    expect(await (await allowedPromise).json()).toMatchObject({ allowed: true });
    expect(plane.handle("POST", CHECK_PATH, checkBody()).body).toMatchObject({ allowed: false });
    slow.end();
  });

  it("keeps a frozen refusal after windows exit during the delay", async () => {
    const plane = new FakeControlPlane();
    const slow = plane.slow(0.01, { path: CHECK_PATH, requests: 1 });
    const refusal = plane.refuseChecks({ status: 503, requests: 1 });
    const pending = post(plane, CHECK_PATH, checkBody());
    slow.end();
    refusal.end();
    expect((await pending).status).toBe(503);
  });

  it("keeps a frozen read-only verdict after both windows exit during the delay", async () => {
    const plane = new FakeControlPlane();
    const slow = plane.slow(0.01, { path: INGEST_PATH, requests: 1 });
    const readOnly = plane.readOnly({ path: INGEST_PATH, requests: 1 });
    const pending = post(plane, INGEST_PATH, [event(91)]);
    slow.end();
    readOnly.end();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      detail: { code: "read_only_key", message: "read-only project key cannot write" },
    });
    expect(plane.ingested).toEqual([]);
  });

  it("aborts an in-flight slow caller after server recording/reservation has committed", async () => {
    const plane = new FakeControlPlane();
    const slow = plane.slow(60, { path: CHECK_PATH, requests: 1 });
    const controller = new AbortController();
    const pending = post(plane, CHECK_PATH, checkBody(), controller.signal);
    expect(plane.checks).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    slow.end();

    expect(
      plane.handle("POST", "/api/v1/budgets/confirm", {
        reservation_id: "res_fake_00000001",
        model: "gpt-4o",
        provider: "openai",
        call_id: "11111111-1111-1111-1111-111111111111",
        token_details: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_tokens: 0,
          audio_input_tokens: 0,
          audio_output_tokens: 0,
        },
      }).status,
    ).toBe(204);

    const preAbortedPlane = new FakeControlPlane();
    const preAbortedSlow = preAbortedPlane.slow(60, { path: CHECK_PATH, requests: 1 });
    const preAbortedController = new AbortController();
    preAbortedController.abort();
    await expect(
      post(preAbortedPlane, CHECK_PATH, checkBody(), preAbortedController.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortedPlane.checks).toHaveLength(1);
    preAbortedSlow.end();
  });

  it("commits a slow confirmation before abort and replays without duplicating settlement", async () => {
    const plane = new FakeControlPlane();
    const checkResponse = await post(plane, CHECK_PATH, checkBody());
    const reservationId = ((await checkResponse.json()) as { reservation_id: string })
      .reservation_id;
    const slow = plane.slow(60, { path: "/api/v1/budgets/confirm", requests: 1 });
    const controller = new AbortController();
    const pending = post(
      plane,
      "/api/v1/budgets/confirm",
      confirmBody(reservationId),
      controller.signal,
    );
    expect(plane.confirms).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const replay = await post(
      plane,
      "/api/v1/budgets/confirm",
      confirmBody(reservationId, "22222222-2222-2222-2222-222222222222"),
    );
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe("");
    expect(plane.confirms).toHaveLength(1);
    slow.end();
  });
});

describe("FakeControlPlane ingest fault scenarios", () => {
  it("records complete overrun batches before throwing and exhausts bounded reject windows", async () => {
    for (const scenario of [
      {
        rejection: { count: 3 },
        failure: "solwyn.testing: rejectIngest count exceeds the batch length",
        overrunEvents: [93, 94],
        nextEvent: 95,
      },
      {
        rejection: { indices: [2] },
        failure: "solwyn.testing: rejectIngest index exceeds the batch length",
        overrunEvents: [96, 97],
        nextEvent: 98,
      },
    ]) {
      const plane = new FakeControlPlane();
      const window = plane.rejectIngest({ ...scenario.rejection, requests: 1 });
      await expect(
        post(
          plane,
          INGEST_PATH,
          scenario.overrunEvents.map((index) => event(index)),
        ),
      ).rejects.toThrow(scenario.failure);
      expect(plane.ingested).toEqual(
        scenario.overrunEvents.map((index) => expect.objectContaining({ model: `model-${index}` })),
      );
      expect(await (await post(plane, INGEST_PATH, [event(scenario.nextEvent)])).json()).toEqual({
        ingested: 1,
        rejected: [],
      });
      window.end();
    }
  });

  it("emits schema-valid exact-index rejections after recording the whole batch", async () => {
    const plane = new FakeControlPlane();
    const window = plane.rejectIngest({ indices: [1], code: "invalid_tags", requests: 1 });
    const response = await post(plane, INGEST_PATH, [event(1), event(2)]);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ingested: 1,
      rejected: [
        {
          index: 1,
          code: "invalid_tags",
          model: "model-2",
          message: "scripted invalid_tags rejection",
        },
      ],
    });
    expect(plane.ingested).toHaveLength(2);
    window.end();
  });

  it("emits only the intentional legacy count and malformed spec-invalid bodies", async () => {
    const plane = new FakeControlPlane();
    const legacy = plane.rejectIngest({ count: 1 });
    const legacyResponse = await post(plane, INGEST_PATH, [event(3), event(4)]);
    expect(await legacyResponse.json()).toEqual({
      ingested: 1,
      rejected: [
        {
          code: "invalid_tags",
          model: "model-3",
          message: "scripted invalid_tags rejection",
        },
      ],
    });
    expect(await (await post(plane, INGEST_PATH, [event(6)])).json()).toEqual({
      ingested: 1,
      rejected: [],
    });
    legacy.end();

    const malformed = plane.rejectIngest({ malformed: true });
    expect(await (await post(plane, INGEST_PATH, [event(5)])).json()).toEqual({
      rejected: "corrupt",
    });
    malformed.end();
  });

  it("applies ingest read-only before validation and keeps invalid lists from consuming rejections", async () => {
    const plane = new FakeControlPlane();
    const rejection = plane.rejectIngest({ indices: [0] });
    const readOnly = plane.readOnly({ path: INGEST_PATH, requests: 1 });

    const invalid = await post(plane, INGEST_PATH, [{ ...event(7), private_prompt: "secret" }]);
    expect(invalid.status).toBe(403);
    expect(plane.ingested).toEqual([]);

    expect(await (await post(plane, INGEST_PATH, [event(8)])).json()).toEqual({
      ingested: 0,
      rejected: [
        {
          index: 0,
          code: "invalid_tags",
          model: "model-8",
          message: "scripted invalid_tags rejection",
        },
      ],
    });
    expect(plane.ingested).toHaveLength(1);
    readOnly.end();

    expect(await (await post(plane, INGEST_PATH, [event(9)])).json()).toEqual({
      ingested: 1,
      rejected: [],
    });
    expect(plane.ingested).toHaveLength(2);
    rejection.end();
  });

  it("applies direct-handle ingest rejections after validation", () => {
    const plane = new FakeControlPlane();
    const rejection = plane.rejectIngest({ indices: [0], requests: 1 });
    expect(
      plane.handle("POST", INGEST_PATH, [{ ...event(92), private_prompt: "secret" }]),
    ).toMatchObject({
      status: 422,
    });
    expect(plane.handle("POST", INGEST_PATH, [event(92)])).toMatchObject({
      status: 202,
      body: { ingested: 0, rejected: [expect.objectContaining({ index: 0 })] },
    });
    expect(plane.ingested).toHaveLength(1);
    rejection.end();
  });
});
