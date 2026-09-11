import { describe, expect, it } from "vitest";
import {
  assertCheckContract,
  assertConfirmContract,
  assertLeaseContract,
  assertReceiptIngestContract,
  assertRunControlContract,
  FakeControlPlane,
} from "../../src/testing/index";
import type { FetchLike } from "../../src/transport";

const JSON_HEADERS = {
  Authorization: `Bearer ${`sk_proj_${"0".repeat(64)}`}`,
  "Content-Type": "application/json",
};

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
  readonly body: Record<string, unknown>;
}

function captureFetch(fetch: FetchLike): {
  readonly fetch: FetchLike;
  readonly requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({
        url: input,
        init,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return fetch(input, init);
    },
  };
}

type ResponseMutation = (response: Response, body: string) => Response;

function mutateResponse(
  fetch: FetchLike,
  matches: (request: CapturedRequest, occurrence: number) => boolean,
  mutation: ResponseMutation,
): FetchLike {
  let occurrence = 0;
  return async (input, init) => {
    const request = {
      url: input,
      init,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    const response = await fetch(input, init);
    if (!matches(request, occurrence++)) return response;
    return mutation(response, await response.text());
  };
}

function jsonMutation(mutate: (body: Record<string, unknown>) => void): ResponseMutation {
  return (response, text) => {
    const body = JSON.parse(text) as Record<string, unknown>;
    mutate(body);
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: response.headers,
    });
  };
}

function setupCheckPlane(options: ConstructorParameters<typeof FakeControlPlane>[0] = {}) {
  const plane = new FakeControlPlane(options);
  plane.denyNext(1, { period: "monthly", scope: "check" });
  plane.denyNext(1, { period: "run_stopped", scope: "check" });
  plane.denyNext(1, { period: "tag", scope: "check" });
  plane.denyRun("contract-agent-run");
  return plane;
}

function setupLeasePlane() {
  const plane = new FakeControlPlane();
  plane.refuseLeases({
    status: 409,
    code: "lease_holder_cap_exceeded",
    requests: 1,
  });
  plane.denyNext(1, { period: "monthly", scope: "lease" });
  return plane;
}

describe("public testing contract helpers", () => {
  it("checks all five verdicts through the injected fetch with absolute authenticated JSON requests", async () => {
    const plane = setupCheckPlane({ priceHints: { "future-provider": 1.25 } });
    const captured = captureFetch(plane.fetch);

    await assertCheckContract(captured.fetch, {
      apiUrl: `${plane.apiUrl}/base/`,
      apiKey: plane.apiKey,
    });

    expect(captured.requests).toHaveLength(5);
    expect(captured.requests.map(({ url }) => url)).toEqual(
      Array.from({ length: 5 }, () => `${plane.apiUrl}/api/v1/budgets/check`),
    );
    for (const request of captured.requests) {
      expect(request.init?.method).toBe("POST");
      expect(request.init?.headers).toEqual(JSON_HEADERS);
      expect(request.body).toMatchObject({
        estimated_input_tokens: 1000,
        model: "gpt-5.5",
        provider: "openai",
        failover_directive_version: "1",
        price_hints_version: "1",
      });
    }
    expect(captured.requests.map(({ body }) => body["tags"])).toEqual([
      { contract_case: "monthly" },
      undefined,
      { customer: "acme" },
      undefined,
      undefined,
    ]);
    expect(captured.requests.map(({ body }) => body["agent_run_id"])).toEqual([
      undefined,
      "contract-stopped-run",
      undefined,
      "contract-agent-run",
      undefined,
    ]);
  });

  it("confirms a reservation, its replays, both XOR failures, and an unknown reservation", async () => {
    const plane = new FakeControlPlane();
    await assertConfirmContract(plane.fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey });

    expect(plane.checks).toHaveLength(1);
    expect(plane.confirms).toHaveLength(1);
    expect(plane.confirms[0]).not.toHaveProperty("lease_id");
  });

  it("exercises the full lease lifecycle without asserting stale-surrender behavior", async () => {
    const plane = setupLeasePlane();
    await assertLeaseContract(plane.fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey });

    expect(plane.leaseGrants).toHaveLength(3);
    expect(plane.leaseRenewals).toHaveLength(3);
    expect(plane.confirms).toHaveLength(1);
    expect(plane.confirms[0]).not.toHaveProperty("reservation_id");
    expect(plane.leaseSurrenders).toHaveLength(2);
  });

  it("accepts an unconstrained response lease ID but diagnoses an incompatible renew request before dispatch", async () => {
    const plane = setupLeasePlane();
    const responseLeaseId = "l".repeat(65);
    const captured = captureFetch(
      mutateResponse(
        plane.fetch,
        (request) => request.body["agent_run_id"] === "contract-lease-eligible",
        jsonMutation((body) => {
          body["lease_id"] = responseLeaseId;
        }),
      ),
    );

    let failure: unknown;
    try {
      await assertLeaseContract(captured.fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[lease.renew-request]");
    expect((failure as Error).message).toContain(
      "accepted response lease_id cannot be represented by the renewal request schema",
    );
    expect((failure as Error).message).not.toContain(responseLeaseId);
    expect(
      captured.requests.filter(
        ({ url }) => new URL(url).pathname === "/api/v1/budgets/lease/renew",
      ),
    ).toHaveLength(0);
  });

  it("does not fabricate a response-side minimum lease ID length", async () => {
    const plane = setupLeasePlane();
    const fetch = mutateResponse(
      plane.fetch,
      (request) => request.body["agent_run_id"] === "contract-lease-eligible",
      jsonMutation((body) => {
        body["lease_id"] = "";
      }),
    );

    await expect(
      assertLeaseContract(fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey }),
    ).rejects.toThrow("[lease.renew-wrong-generation]");
  });

  it("validates opted-in, legacy, and unstopped run-control responses", async () => {
    const plane = new FakeControlPlane();
    plane.stopRun("contract-stopped-by-caller", { reason: "operator_stop" });

    await assertRunControlContract(plane.fetch, {
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      stoppedRunId: "contract-stopped-by-caller",
    });

    expect(plane.checks).toHaveLength(3);
    expect(plane.checks[0]?.run_directive_version).toBe("1");
    expect(plane.checks[1]?.run_directive_version).toBeUndefined();
    expect(plane.checks[2]?.agent_run_id).toMatch(/^contract-unstopped-[0-9a-f]+$/);
  });

  it("ingests exactly one server denial and one aggregate replay", async () => {
    const plane = new FakeControlPlane();
    await assertReceiptIngestContract(plane.fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey });

    expect(plane.denialReceipts).toHaveLength(2);
    expect(plane.aggregateReplays).toHaveLength(1);
    expect(plane.denialReceipts[0]).toMatchObject({
      status: "budget_denied",
      deny_source: "server",
      deny_reason: "monthly",
      denied_by_period: "monthly",
      input_tokens: 1000,
      estimated_output_bound: 512,
      velocity_flags: ["monotonic_growth", "repeat_size"],
    });
    expect(plane.aggregateReplays[0]).toMatchObject({
      deny_source: "aggregate_replay",
      input_tokens: 3000,
      receipt_aggregate_count: 3,
    });
  });

  it.each([
    ["boolean", true],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a %s check price-hint value", async (_name, value) => {
    const plane = setupCheckPlane({ priceHints: { "future-provider": 1 } });
    const fetch = mutateResponse(
      plane.fetch,
      (_request, occurrence) => occurrence === 0,
      (_response, text) =>
        new Response(
          value === true
            ? text.replace('"future-provider":1', '"future-provider":true')
            : text.replace('"future-provider":1', '"future-provider":1e309'),
          { status: 200 },
        ),
    );

    await expect(
      assertCheckContract(fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey }),
    ).rejects.toThrow(/\[check\.monthly\].*price_hints/);
  });

  it.each([
    ["malformed JSON", (_response: Response) => new Response("{", { status: 200 })],
    [
      "schema drift",
      jsonMutation((body) => {
        body["unexpected"] = true;
      }),
    ],
    ["wrong status", (_response: Response, text: string) => new Response(text, { status: 201 })],
  ] satisfies ReadonlyArray<
    readonly [string, ResponseMutation]
  >)("rejects check %s", async (_name, mutation) => {
    const plane = setupCheckPlane();
    const fetch = mutateResponse(plane.fetch, (_request, occurrence) => occurrence === 0, mutation);
    await expect(
      assertCheckContract(fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey }),
    ).rejects.toThrow("[check.monthly]");
  });

  it("bounds and JSON-escapes a multibyte error-body preview to 200 UTF-8 bytes", async () => {
    const secretTail = "NEVER_INCLUDE_THIS_TAIL";
    const body = `${"é".repeat(99)}\n"\\é${secretTail}`;
    const fetch: FetchLike = async () => new Response(body, { status: 503 });

    let failure: unknown;
    try {
      await assertCheckContract(fetch, {
        apiUrl: "https://control-plane.example/base",
        apiKey: "contract-key",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("[check.monthly]");
    expect(message).toContain('body preview="');
    expect(message).toContain("\\n");
    expect(message).not.toContain(secretTail);
    expect(message).not.toContain('\n"');
  });

  it.each([
    [
      "incomplete authority",
      jsonMutation((body) => {
        delete body["posture"];
      }),
    ],
    [
      "boolean integer",
      jsonMutation((body) => {
        body["generation"] = true;
      }),
    ],
  ] satisfies ReadonlyArray<
    readonly [string, ResponseMutation]
  >)("rejects lease %s", async (_name, mutation) => {
    const plane = setupLeasePlane();
    const fetch = mutateResponse(
      plane.fetch,
      (request) =>
        new URL(request.url).pathname === "/api/v1/budgets/lease" &&
        request.body["agent_run_id"] === "contract-lease-eligible",
      mutation,
    );

    await expect(
      assertLeaseContract(fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey }),
    ).rejects.toThrow("[lease.grant]");
  });

  it("rejects an invalid run-control directive", async () => {
    const plane = new FakeControlPlane();
    plane.stopRun("contract-stopped-by-caller");
    const fetch = mutateResponse(
      plane.fetch,
      (_request, occurrence) => occurrence === 0,
      jsonMutation((body) => {
        (body["run_control"] as Record<string, unknown>)["action"] = "pause";
      }),
    );

    await expect(
      assertRunControlContract(fetch, {
        apiUrl: plane.apiUrl,
        apiKey: plane.apiKey,
        stoppedRunId: "contract-stopped-by-caller",
      }),
    ).rejects.toThrow("[run-control.opted-in]");
  });

  it.each([
    [
      "wrong count",
      jsonMutation((body) => {
        body["ingested"] = 0;
      }),
    ],
    [
      "rejections",
      jsonMutation((body) => {
        body["rejected"] = [
          { index: 0, code: "unknown_model", model: "gpt-5.5", message: "rejected" },
        ];
      }),
    ],
  ] satisfies ReadonlyArray<
    readonly [string, ResponseMutation]
  >)("rejects receipt-ingest %s", async (_name, mutation) => {
    const plane = new FakeControlPlane();
    const fetch = mutateResponse(plane.fetch, (_request, occurrence) => occurrence === 0, mutation);

    await expect(
      assertReceiptIngestContract(fetch, { apiUrl: plane.apiUrl, apiKey: plane.apiKey }),
    ).rejects.toThrow("[receipt.server-denial]");
  });
});
