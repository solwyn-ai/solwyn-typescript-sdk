import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import type { Logger } from "../../src/logging";
import { MetadataReporter } from "../../src/reporter";
import { createTokenDetails, zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_URL = "https://api.solwyn.ai";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const INGEST_URL = `${API_URL}/api/v1/metadata/ingest`;
const CONFIRM_URL = `${API_URL}/api/v1/budgets/confirm`;

/** Deterministic canonical UUIDs keep queue-order assertions readable and valid. */
function testCallId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Fixtures + fakes.
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<MetadataEvent> = {}): MetadataEvent {
  return MetadataEventSchema.parse({
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 100,
    status: "success",
    is_model_fallback: false,
    call_id: testCallId(1),
    sdk_instance_id: "sdk-1",
    timestamp: "2026-07-03T00:00:00Z",
    ...overrides,
  }) as MetadataEvent;
}

function makeConfirm(overrides: Partial<BudgetConfirmRequest> = {}): BudgetConfirmRequest {
  return BudgetConfirmRequestSchema.parse({
    reservation_id: "res-1",
    model: "gpt-4o",
    provider: "openai",
    call_id: testCallId(1),
    token_details: zeroTokenDetails(),
    ...overrides,
  }) as BudgetConfirmRequest;
}

interface FetchRecord {
  url: string;
  body: string;
}

type Responder = (url: string, body: string) => Response | Promise<Response>;

function makeFetch(records: FetchRecord[], responder: Responder): FetchLike {
  return async (url, init) => {
    records.push({ url: String(url), body: String(init?.body ?? "") });
    return responder(String(url), String(init?.body ?? ""));
  };
}

function ingest202(rejected: unknown[] = [], ingested = 0): Response {
  return new Response(JSON.stringify({ ingested, rejected }), { status: 202 });
}

interface CapturedLogger {
  logger: Logger;
  debug: string[];
  info: string[];
  warn: string[];
  error: string[];
}

function capturingLogger(): CapturedLogger {
  const captured: CapturedLogger = {
    debug: [],
    info: [],
    warn: [],
    error: [],
    logger: {
      debug: (m: string) => captured.debug.push(m),
      info: (m: string) => captured.info.push(m),
      warn: (m: string) => captured.warn.push(m),
      error: (m: string) => captured.error.push(m),
    },
  };
  return captured;
}

interface CapturedLogCall {
  level: keyof Logger;
  args: readonly unknown[];
}

interface ArgumentCapturingLogger {
  logger: Logger;
  calls: CapturedLogCall[];
}

/** Capture every positional log argument, including non-string objects. */
function argumentCapturingLogger(): ArgumentCapturingLogger {
  const calls: CapturedLogCall[] = [];
  const capture = (level: keyof Logger, args: readonly unknown[]): void => {
    calls.push({ level, args });
  };
  return {
    calls,
    logger: {
      debug: (...args) => capture("debug", args),
      info: (...args) => capture("info", args),
      warn: (...args) => capture("warn", args),
      error: (...args) => capture("error", args),
    },
  };
}

function capturedArguments(capture: ArgumentCapturingLogger): unknown[] {
  return capture.calls.flatMap((call) => call.args);
}

type ThrowingLogLevel = "debug" | "warn" | "error";

function loggerThrowingAt(...levels: ThrowingLogLevel[]): Logger {
  const throwing = new Set(levels);
  const emit = (level: ThrowingLogLevel): void => {
    if (throwing.has(level)) {
      throw new Error(`${level} logger failed`);
    }
  };
  return {
    debug: () => emit("debug"),
    info: () => {},
    warn: () => emit("warn"),
    error: () => emit("error"),
  };
}

/** A reporter whose transport always succeeds with a clean 202 / 204. */
function healthyReporter(records: FetchRecord[], options = {}) {
  const log = capturingLogger();
  const fetchImpl = makeFetch(records, (url) =>
    url.endsWith("/metadata/ingest") ? ingest202() : new Response(null, { status: 204 }),
  );
  const reporter = new MetadataReporter(API_URL, API_KEY, {
    fetch: fetchImpl,
    logger: log.logger,
    ...options,
  });
  return { reporter, log };
}

describe("MetadataReporter — throwing diagnostic containment", () => {
  it("throwing reporter diagnostic: breaker-open debug does not escape confirm", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
    breaker.recordFailure();
    const fetch = vi.fn<FetchLike>();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      fetch,
      logger: loggerThrowingAt("debug"),
    });

    await expect(reporter._sendConfirm(makeConfirm())).resolves.toBe("held");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throwing reporter diagnostic: confirm warning does not stop later confirms", async () => {
    const records: FetchRecord[] = [];
    let attempt = 0;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => {
        attempt += 1;
        return attempt === 1
          ? new Response("", { status: 400 })
          : new Response(null, { status: 204 });
      }),
      logger: loggerThrowingAt("warn"),
    });
    reporter.reportConfirm(makeConfirm({ call_id: testCallId(91) }));
    reporter.reportConfirm(makeConfirm({ call_id: testCallId(92) }));

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(records.map((record) => record.url)).toEqual([CONFIRM_URL, CONFIRM_URL]);
    expect(reporter.confirmQueueSize).toBe(0);
  });

  it("throwing reporter diagnostic: batch failure warning remains swallowed", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: () => Promise.reject(new TypeError("private transport detail")),
      logger: loggerThrowingAt("warn"),
    });

    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "retry" });
    expect(reporter.inFlightCount).toBe(0);
  });

  it("throwing reporter diagnostic: unparseable warning does not stop a later batch", async () => {
    const records: FetchRecord[] = [];
    let attempt = 0;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => {
        attempt += 1;
        return attempt === 1 ? new Response("{", { status: 202 }) : ingest202();
      }),
      logger: loggerThrowingAt("warn"),
    });

    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "sent" });
    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "sent" });
    expect(records.map((record) => record.url)).toEqual([INGEST_URL, INGEST_URL]);
  });

  it("throwing reporter diagnostic: persistent parse error cannot reject final close", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 1,
      maxInFlight: 1,
      fetch: makeFetch(records, () => new Response("{", { status: 202 })),
      logger: loggerThrowingAt("error"),
    });
    for (let index = 0; index < 10; index += 1) {
      reporter.report(makeEvent({ call_id: testCallId(100 + index) }));
    }

    await expect(reporter.close()).resolves.toBeUndefined();
    expect(records).toHaveLength(10);
    expect(reporter.inFlightCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sans-I/O queue behaviors.
// ---------------------------------------------------------------------------

describe("MetadataReporter — queue internals", () => {
  it("_enqueue adds an event and grows the queue by one", () => {
    const { reporter } = healthyReporter([]);
    expect(reporter.metadataQueueSize).toBe(0);
    reporter._enqueue(makeEvent());
    expect(reporter.metadataQueueSize).toBe(1);
  });

  it("_drainBatch returns up to batchSize, oldest-first, leaving the remainder", () => {
    const { reporter } = healthyReporter([], { batchSize: 3 });
    for (let i = 0; i < 5; i++) {
      reporter._enqueue(makeEvent({ call_id: testCallId(i) }));
    }
    const batch = reporter._drainBatch();
    expect(batch.map((e) => e.call_id)).toEqual([testCallId(0), testCallId(1), testCallId(2)]);
    expect(reporter.metadataQueueSize).toBe(2);
  });

  it("_drainBatch returns all events and empties the queue when fewer than batchSize", () => {
    const { reporter } = healthyReporter([], { batchSize: 3 });
    reporter._enqueue(makeEvent({ call_id: testCallId(1) }));
    reporter._enqueue(makeEvent({ call_id: testCallId(2) }));
    const batch = reporter._drainBatch();
    expect(batch.map((e) => e.call_id)).toEqual([testCallId(1), testCallId(2)]);
    expect(reporter.metadataQueueSize).toBe(0);
  });

  it("bounded metadata queue drops the OLDEST on overflow, keeping newest N in order", () => {
    const { reporter } = healthyReporter([], { maxQueueSize: 3 });
    for (let i = 0; i < 5; i++) {
      reporter.report(makeEvent({ call_id: testCallId(i) }));
    }
    expect(reporter.metadataQueueSize).toBe(3);
    const remaining = reporter._drainBatch();
    expect(remaining.map((e) => e.call_id)).toEqual([testCallId(2), testCallId(3), testCallId(4)]);
  });

  it("confirm and settlement queues are each bounded at 1000 (drop-oldest)", () => {
    const { reporter } = healthyReporter([]);
    for (let i = 0; i < 1001; i++) {
      reporter.reportConfirm(makeConfirm({ call_id: testCallId(i) }));
      reporter.reportSettlement(
        makeConfirm({ call_id: testCallId(10_000 + i) }),
        makeEvent({ call_id: testCallId(20_000 + i) }),
      );
    }
    expect(reporter.confirmQueueSize).toBe(1000);
    expect(reporter.settlementQueueSize).toBe(1000);
  });

  it("report() never throws and counts/logs a full-queue drop", () => {
    const { reporter, log } = healthyReporter([], { maxQueueSize: 1 });
    expect(() => {
      reporter.report(makeEvent({ call_id: testCallId(1) }));
      reporter.report(makeEvent({ call_id: testCallId(2) }));
    }).not.toThrow();
    expect(reporter.metadataQueueSize).toBe(1);
    expect(log.warn).toEqual(["reporter.spend_events_dropped: new=%d totals=%s"]);
    expect(log.error).toHaveLength(0);
  });

  it("_authHeaders returns exactly the two required headers", () => {
    const { reporter } = healthyReporter([]);
    expect(reporter._authHeaders()).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
  });
});

// ---------------------------------------------------------------------------
// Confirm-failure counter (invariant 8) + unparseable counter.
// ---------------------------------------------------------------------------

describe("MetadataReporter — consecutive-failure counters", () => {
  it("confirm failures 1-9 log WARNING; the 10th escalates to ERROR at exactly 10", () => {
    const { reporter, log } = healthyReporter([]);
    for (let i = 0; i < 9; i++) {
      reporter._recordConfirmFailure(new TypeError("boom secret 500"));
    }
    expect(log.warn).toHaveLength(9);
    expect(log.error).toHaveLength(0);
    expect(log.warn[0]).toBe("reporter.confirm_send_failed: exc_type=TypeError");
    // Only the class name — never the message body.
    expect(log.warn.join("\n")).not.toContain("boom");
    expect(log.warn.join("\n")).not.toContain("500");

    reporter._recordConfirmFailure(new TypeError("boom"));
    expect(log.error).toHaveLength(1);
    expect(log.error[0]).toBe(
      "reporter.confirm_send_persistent_failure: exc_type=TypeError consecutive_failures=10",
    );
  });

  it("a single confirm success resets the counter to 0", () => {
    const { reporter, log } = healthyReporter([]);
    for (let i = 0; i < 9; i++) {
      reporter._recordConfirmFailure(new Error("x"));
    }
    reporter._recordConfirmSuccess();
    reporter._recordConfirmFailure(new Error("x"));
    // Back to WARNING (count restarted), no ERROR emitted.
    expect(log.error).toHaveLength(0);
    expect(log.warn.at(-1)).toBe("reporter.confirm_send_failed: exc_type=Error");
  });

  it("unparseable-response counter escalates at 10 then resets on a parseable response", () => {
    const { reporter, log } = healthyReporter([]);
    for (let i = 0; i < 9; i++) {
      reporter._recordUnparseableResponse(new TypeError("nope"));
    }
    expect(log.warn).toHaveLength(9);
    expect(log.warn[0]).toBe("reporter.ingest_response_unparseable: exc_type=TypeError");
    reporter._recordUnparseableResponse(new TypeError("nope"));
    expect(log.error[0]).toBe(
      "reporter.ingest_response_unparseable_persistent: exc_type=TypeError consecutive_failures=10",
    );

    reporter._recordParseableResponse();
    reporter._recordUnparseableResponse(new TypeError("nope"));
    expect(log.error).toHaveLength(1); // counter reset → back to WARNING
  });
});

// ---------------------------------------------------------------------------
// 202 rejection-body parsing + logging.
// ---------------------------------------------------------------------------

describe("MetadataReporter — ingest 202 rejection logging", () => {
  it("logs one WARNING per distinct (code, model), correct counts, FIRST message kept", async () => {
    const rejected = [
      { index: 0, code: "unknown_model", model: "m1", message: "first m1 msg" },
      { index: 1, code: "unknown_model", model: "m1", message: "second m1 msg (discarded)" },
      { index: 2, code: "unknown_service_tier", model: "m1", message: "tier msg" },
      { index: 3, code: "unknown_model", model: "m2", message: "m2 msg" },
    ];
    const records: FetchRecord[] = [];
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch(records, () => ingest202(rejected, 0)),
    });

    await reporter._sendBatch([makeEvent(), makeEvent(), makeEvent(), makeEvent()]);

    expect(log.warn).toHaveLength(3);
    expect(log.warn).toContain(
      "reporter.ingest_events_rejected: code=unknown_model model=m1 count=2 message=first m1 msg",
    );
    expect(log.warn).toContain(
      "reporter.ingest_events_rejected: code=unknown_service_tier model=m1 count=1 message=tier msg",
    );
    expect(log.warn).toContain(
      "reporter.ingest_events_rejected: code=unknown_model model=m2 count=1 message=m2 msg",
    );
    // First message kept, later duplicate discarded (not concatenated).
    expect(log.warn.join("\n")).not.toContain("discarded");
  });

  it("an all-rejected 202 (ingested:0) is a normal response and does not raise", async () => {
    const rejected = [{ index: 0, code: "unknown_model", model: "m", message: "msg" }];
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => ingest202(rejected, 0)),
    });
    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "sent" });
    expect(log.warn).toHaveLength(1);
    expect(log.error).toHaveLength(0);
  });

  it("an empty rejected list logs nothing", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => ingest202([], 1)),
    });
    await reporter._sendBatch([makeEvent()]);
    expect(log.warn).toHaveLength(0);
    expect(log.error).toHaveLength(0);
  });

  it("logs the server message verbatim (format-looking / escape-looking substrings intact)", async () => {
    const message = "bad model %s see https://x?q=1 \\n literal";
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () =>
        ingest202([{ index: 0, code: "unknown_model", model: "m", message }]),
      ),
    });
    await reporter._sendBatch([makeEvent()]);
    expect(log.warn[0]).toContain(`message=${message}`);
  });

  it("logs an unrecognized/future rejection code without crashing", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () =>
        ingest202([{ index: 0, code: "some_future_code", model: "m", message: "msg" }]),
      ),
    });
    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "sent" });
    expect(log.warn[0]).toContain("code=some_future_code");
  });

  it("escapes raw control bytes in echoed values (raw byte never in the log line)", async () => {
    const model = "m\x1bodel\nx"; // ESC + newline
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () =>
        ingest202([{ index: 0, code: "unknown_model", model, message: "ok" }]),
      ),
    });
    await reporter._sendBatch([makeEvent()]);
    const line = log.warn[0] ?? "";
    expect(line).toContain("\\x1b");
    expect(line).toContain("\\n");
    expect(line).not.toContain("\x1b");
    expect(line).not.toContain("\nx");
  });
});

// ---------------------------------------------------------------------------
// Malformed / fail-open 202 bodies.
// ---------------------------------------------------------------------------

describe("MetadataReporter — malformed 202 bodies fail open", () => {
  const cases: Array<[string, string]> = [
    ["missing 'rejected' key", JSON.stringify({ ingested: 1 })],
    ["'rejected' is null", JSON.stringify({ ingested: 1, rejected: null })],
    ["'rejected' is not a list", JSON.stringify({ ingested: 1, rejected: { a: 1 } })],
    ["non-object rejection entry", JSON.stringify({ ingested: 0, rejected: ["nope"] })],
  ];

  it.each(cases)("fails open and logs exactly one unparseable line: %s", async (_label, body) => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => new Response(body, { status: 202 })),
    });
    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "sent" });
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toMatch(/^reporter\.ingest_response_unparseable: exc_type=\w+$/);
    // Fail-open: never labeled a whole-batch send failure.
    expect(log.warn.join("\n")).not.toContain("Failed to send metadata batch");
  });

  it("a body that is not valid JSON at all fails open identically", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => new Response("<html>not json</html>", { status: 202 })),
    });
    await reporter._sendBatch([makeEvent()]);
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toContain("reporter.ingest_response_unparseable: exc_type=");
  });

  it("a 'rejected' array longer than the submitted batch fails open (contract violation)", async () => {
    const rejected = [
      { index: 0, code: "unknown_model", model: "m", message: "a" },
      { index: 1, code: "unknown_model", model: "m", message: "b" },
    ];
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => ingest202(rejected)),
    });
    // Only ONE event submitted, but TWO rejections echoed back.
    await reporter._sendBatch([makeEvent()]);
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toContain("reporter.ingest_response_unparseable");
  });

  it("consecutive unparseable 202 bodies escalate to ERROR at the 10th", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => new Response("{}", { status: 202 })), // missing 'rejected'
    });
    for (let i = 0; i < 10; i++) {
      await reporter._sendBatch([makeEvent()]);
    }
    expect(log.error).toHaveLength(1);
    expect(log.error[0]).toContain("reporter.ingest_response_unparseable_persistent: exc_type=");
    expect(log.error[0]).toContain("consecutive_failures=10");
  });

  it("a raising log stack does NOT mislabel a durable (202'd) batch as a send failure", async () => {
    const warnCalls: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (m: string) => {
        warnCalls.push(m);
        if (m.includes("ingest_events_rejected")) {
          throw new Error("user log filter exploded");
        }
      },
    };
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      fetch: makeFetch([], () =>
        ingest202([{ index: 0, code: "unknown_model", model: "m", message: "msg" }]),
      ),
    });
    // The emit throws internally; it must be swallowed entirely, not re-labeled.
    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "sent" });
    expect(warnCalls.some((m) => m.includes("ingest_events_rejected"))).toBe(true);
    expect(warnCalls.some((m) => m.includes("Failed to send metadata batch"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _sendBatch wire payload.
// ---------------------------------------------------------------------------

describe("MetadataReporter — ingest wire payload", () => {
  it("POSTs a JSON array to the exact ingest path", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => ingest202()),
    });
    await reporter._sendBatch([
      makeEvent({ call_id: testCallId(21) }),
      makeEvent({ call_id: testCallId(22) }),
    ]);
    expect(records[0]?.url).toBe(INGEST_URL);
    const payload = JSON.parse(records[0]?.body ?? "null");
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0].call_id).toBe(testCallId(21));
    expect(payload[1].call_id).toBe(testCallId(22));
  });

  it("omits null/undefined optional fields from the payload (never sent as null)", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => ingest202()),
    });
    await reporter._sendBatch([makeEvent()]); // no service_tier, no token_details, no agent_run_*
    const payload = JSON.parse(records[0]?.body ?? "null");
    const event = payload[0];
    expect("service_tier" in event).toBe(false);
    expect("token_details" in event).toBe(false);
    expect("agent_run_id" in event).toBe(false);
    expect("agent_run_name" in event).toBe(false);
    // But call_id and defaulted booleans stay on the wire.
    expect(event.call_id).toBe(testCallId(1));
    expect(event.is_provider_fallback).toBe(false);
    expect(event.attempt_index).toBe(0);
  });

  it("includes service_tier when present with its exact value", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => ingest202()),
    });
    await reporter._sendBatch([makeEvent({ service_tier: "flex" })]);
    const payload = JSON.parse(records[0]?.body ?? "null");
    expect(payload[0].service_tier).toBe("flex");
  });

  it("includes agent_run_id/agent_run_name when set; omits both when unset", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => ingest202()),
    });
    await reporter._sendBatch([
      makeEvent({ call_id: testCallId(31), agent_run_id: "run-7", agent_run_name: "nightly" }),
    ]);
    await reporter._sendBatch([makeEvent({ call_id: testCallId(32) })]);

    const withRun = JSON.parse(records[0]?.body ?? "null")[0];
    expect(withRun.agent_run_id).toBe("run-7");
    expect(withRun.agent_run_name).toBe("nightly");

    const withoutRun = JSON.parse(records[1]?.body ?? "null")[0];
    expect("agent_run_id" in withoutRun).toBe(false);
    expect("agent_run_name" in withoutRun).toBe(false);
  });

  it("serializes embedded token_details, omitting is_estimated when false", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => ingest202()),
    });
    await reporter._sendBatch([
      makeEvent({ token_details: createTokenDetails({ input_tokens: 3, output_tokens: 2 }) }),
    ]);
    const td = JSON.parse(records[0]?.body ?? "null")[0].token_details;
    expect(td.input_tokens).toBe(3);
    expect("is_estimated" in td).toBe(false);
  });

  // Mutation caught: validating a raw cast but serializing the caller-owned
  // original drops MetadataEventSchema defaults from the wire projection.
  it("sends schema-normalized defaults from a raw metadata event", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => ingest202()),
    });
    const {
      modality: _modality,
      is_provider_fallback: _isProviderFallback,
      attempt_index: _attemptIndex,
      ...withoutDefaults
    } = makeEvent({ call_id: testCallId(33) });

    await reporter._sendBatch([withoutDefaults as MetadataEvent]);

    const payload = JSON.parse(records[0]?.body ?? "null")[0];
    expect(payload.modality).toBe("text");
    expect(payload.is_provider_fallback).toBe(false);
    expect(payload.attempt_index).toBe(0);
  });

  // Mutation caught: re-reading the caller object after safeParse accesses an
  // enumerable getter twice and can discard the first validated value.
  it("reads an event getter once and sends its first validated value", async () => {
    const records: FetchRecord[] = [];
    let reads = 0;
    const raw = makeEvent({ call_id: testCallId(34) });
    Object.defineProperty(raw, "model", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) throw new Error("SECRET_EVENT_SECOND_READ");
        return "gpt-first";
      },
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => ingest202()),
    });

    await expect(reporter._sendBatch([raw])).resolves.toMatchObject({ outcome: "sent" });

    expect(reads).toBe(1);
    expect(JSON.parse(records[0]?.body ?? "null")[0].model).toBe("gpt-first");
  });
});

// ---------------------------------------------------------------------------
// Outgoing event validation: each event is parsed against MetadataEventSchema
// before send; a bad event is dropped fail-open, never blocking the batch.
// ---------------------------------------------------------------------------

describe("MetadataReporter — outgoing event validation (F5)", () => {
  /** A structurally valid MetadataEvent mutated to violate the schema (bypasses parse). */
  function oversizedModelEvent(overrides: Partial<MetadataEvent> = {}): MetadataEvent {
    return { ...makeEvent(overrides), model: "x".repeat(2049) } as MetadataEvent;
  }

  it("drops the invalid event and still POSTs the valid remainder of the batch", async () => {
    const records: FetchRecord[] = [];
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch(records, () => ingest202()),
    });

    await reporter._sendBatch([
      makeEvent({ call_id: testCallId(41) }),
      oversizedModelEvent({ call_id: testCallId(42) }),
      makeEvent({ call_id: testCallId(43) }),
    ]);

    // Exactly one POST, carrying only the two valid events (no 422 of the batch).
    expect(records).toHaveLength(1);
    const payload = JSON.parse(records[0]?.body ?? "null") as Array<{ call_id: string }>;
    expect(payload.map((e) => e.call_id)).toEqual([testCallId(41), testCallId(43)]);

    // One privacy-safe poison line plus the synchronous disposition summary.
    expect(log.warn).toHaveLength(2);
    expect(log.warn[0]).toContain("reporter.ingest_event_unserializable:");
    expect(log.warn[0]).toContain("fields=model");
    expect(log.warn[0]).toContain("exc_type=");
    expect(log.warn[1]).toBe("reporter.spend_events_dropped: new=%d totals=%s");
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
  });

  it("a batch of only-invalid events POSTs nothing (no durable send) but still logs the drop", async () => {
    const records: FetchRecord[] = [];
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch(records, () => ingest202()),
    });

    await expect(reporter._sendBatch([oversizedModelEvent()])).resolves.toMatchObject({
      outcome: "dropped",
    });

    expect(records).toHaveLength(0);
    expect(log.warn).toHaveLength(2);
    expect(log.warn[0]).toContain("reporter.ingest_event_unserializable:");
    expect(log.warn[1]).toBe("reporter.spend_events_dropped: new=%d totals=%s");
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
  });

  it("never logs the offending field VALUE — only its name and error class (privacy)", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => ingest202()),
    });

    // A content-looking oversized value that must never appear in any log line.
    const secret = `SECRET_${"z".repeat(2049)}`;
    await reporter._sendBatch([{ ...makeEvent(), model: secret } as MetadataEvent]);

    const everything = [...log.debug, ...log.info, ...log.warn, ...log.error].join("\n");
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("zzzz");
  });

  it("persistent invalid events escalate to ERROR on the shared unparseable counter", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => ingest202()),
    });

    for (let i = 0; i < 10; i++) {
      await reporter._sendBatch([oversizedModelEvent()]);
    }
    expect(log.error).toHaveLength(1);
    expect(log.error[0]).toContain("reporter.ingest_event_unserializable_persistent:");
    expect(log.error[0]).toContain("consecutive_failures=10");
  });

  // Mutation caught: an uncaught getter exception from safeParse aborts the
  // complete direct batch instead of disposing only that poison event.
  it("isolates a throwing event getter and sends its valid neighbor privacy-safely", async () => {
    const records: FetchRecord[] = [];
    const log = capturingLogger();
    const poison = makeEvent({ call_id: testCallId(44) });
    Object.defineProperty(poison, "model", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error("SECRET_EVENT_GETTER_VALUE");
      },
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch(records, () => ingest202()),
    });

    await expect(
      reporter._sendBatch([poison, makeEvent({ call_id: testCallId(45) })]),
    ).resolves.toMatchObject({ outcome: "sent" });

    const payload = JSON.parse(records[0]?.body ?? "null") as Array<{ call_id: string }>;
    expect(payload.map((item) => item.call_id)).toEqual([testCallId(45)]);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
    expect(log.warn).toEqual([
      "reporter.ingest_event_unserializable: fields=<unknown> exc_type=Error",
      "reporter.spend_events_dropped: new=%d totals=%s",
    ]);
    expect([...log.warn, ...log.error].join("\n")).not.toContain("SECRET_EVENT_GETTER_VALUE");
  });

  // Mutation caught: reflecting through `.constructor.name` for an arbitrary
  // null-prototype throw escapes direct projection and prevents the valid POST.
  it("contains a null-prototype value thrown by a direct event getter", async () => {
    const records: FetchRecord[] = [];
    const log = argumentCapturingLogger();
    const thrown = Object.create(null) as { secret: string };
    thrown.secret = "SECRET_NULL_PROTOTYPE_EVENT";
    const poison = makeEvent({ call_id: testCallId(46) });
    Object.defineProperty(poison, "model", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw thrown;
      },
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch(records, (_url, body) =>
        ingest202([], (JSON.parse(body) as unknown[]).length),
      ),
    });

    let escaped = false;
    let outcome: string | undefined;
    try {
      outcome = (await reporter._sendBatch([poison, makeEvent({ call_id: testCallId(47) })]))
        .outcome;
    } catch {
      escaped = true;
    }

    expect({ escaped, outcome }).toEqual({ escaped: false, outcome: "sent" });
    expect(
      JSON.parse(records[0]?.body ?? "null").map((item: MetadataEvent) => item.call_id),
    ).toEqual([testCallId(47)]);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
    expect(log.calls).toContainEqual({
      level: "warn",
      args: ["reporter.ingest_event_unserializable: fields=<unknown> exc_type=object"],
    });
    const args = capturedArguments(log);
    expect(args.some((arg) => arg === thrown)).toBe(false);
    expect(args.some((arg) => typeof arg === "object" && arg !== null)).toBe(false);
    expect(args.filter((arg): arg is string => typeof arg === "string").join("\n")).not.toContain(
      "SECRET_NULL_PROTOTYPE_EVENT",
    );
  });

  // Mutation caught: reading a hostile Error.name while handling a queued
  // projection failure rejects the cycle, strands its claim, and blocks recovery.
  it("contains a hostile Error name from a queued event and leaves later cycles healthy", async () => {
    const records: FetchRecord[] = [];
    const log = argumentCapturingLogger();
    const thrown = new Error("SECRET_EVENT_EXCEPTION_MESSAGE");
    Object.defineProperty(thrown, "name", {
      configurable: true,
      get: () => {
        throw new Error("SECRET_EVENT_NAME_ACCESSOR");
      },
    });
    const poison = makeEvent({ call_id: testCallId(48) });
    Object.defineProperty(poison, "model", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw thrown;
      },
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 2,
      logger: log.logger,
      fetch: makeFetch(records, (_url, body) =>
        ingest202([], (JSON.parse(body) as unknown[]).length),
      ),
    });
    reporter.report(poison);
    reporter.report(makeEvent({ call_id: testCallId(49) }));

    let escaped = false;
    let firstCycle: boolean | undefined;
    try {
      firstCycle = await reporter._flushRemaining();
    } catch {
      escaped = true;
    }

    expect({ escaped, firstCycle }).toEqual({ escaped: false, firstCycle: false });
    reporter.report(makeEvent({ call_id: testCallId(50) }));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await reporter.close(100);

    expect(
      records.map((record) =>
        (JSON.parse(record.body) as MetadataEvent[]).map((item) => item.call_id),
      ),
    ).toEqual([[testCallId(49)], [testCallId(50)]]);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
    expect(log.calls).toContainEqual({
      level: "warn",
      args: ["reporter.ingest_event_unserializable: fields=<unknown> exc_type=Error"],
    });
    const args = capturedArguments(log);
    expect(args.some((arg) => arg === thrown)).toBe(false);
    expect(args.some((arg) => typeof arg === "object" && arg !== null)).toBe(false);
    const strings = args.filter((arg): arg is string => typeof arg === "string").join("\n");
    expect(strings).not.toContain("SECRET_EVENT_EXCEPTION_MESSAGE");
    expect(strings).not.toContain("SECRET_EVENT_NAME_ACCESSOR");
  });
});

// ---------------------------------------------------------------------------
// Whole-batch send failures.
// ---------------------------------------------------------------------------

describe("MetadataReporter — send-failure handling", () => {
  it("an ingest 4xx is logged type-only (never the body) and does not raise", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch([], () => new Response('{"detail":"Batch too large"}', { status: 400 })),
    });
    await expect(reporter._sendBatch([makeEvent(), makeEvent()])).resolves.toMatchObject({
      outcome: "dropped",
    });
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toBe("Failed to send metadata batch (2 events): TransportHttpError");
    expect(log.warn[0]).not.toContain("Batch too large");
    expect(log.warn[0]).not.toContain("400");
  });

  it("a raw network error from the POST is caught and swallowed", async () => {
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: () => Promise.reject(new TypeError("connection refused")),
    });
    await expect(reporter._sendBatch([makeEvent()])).resolves.toMatchObject({ outcome: "retry" });
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toContain(
      "Failed to send metadata batch (1 events): TransportNetworkError",
    );
    expect(log.warn[0]).not.toContain("connection refused");
  });

  it("rejected events are terminal — a second flush with nothing new sends nothing", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () =>
        ingest202([{ index: 0, code: "unknown_model", model: "m", message: "msg" }]),
      ),
    });
    reporter.report(makeEvent());
    await reporter._flushRemaining();
    expect(records).toHaveLength(1);
    expect(reporter.metadataQueueSize).toBe(0);
    await reporter._flushRemaining();
    expect(records).toHaveLength(1); // nothing re-queued
  });
});

// ---------------------------------------------------------------------------
// Confirm sending + flush ordering.
// ---------------------------------------------------------------------------

describe("MetadataReporter — confirm sending", () => {
  it("POSTs one confirm object (not an array) to the exact confirm path", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => new Response(null, { status: 204 })),
    });
    await reporter._sendConfirm(makeConfirm({ call_id: testCallId(51) }));
    expect(records[0]?.url).toBe(CONFIRM_URL);
    const payload = JSON.parse(records[0]?.body ?? "null");
    expect(Array.isArray(payload)).toBe(false);
    expect(payload.call_id).toBe(testCallId(51));
    expect("provider_region" in payload).toBe(false); // omitted when unset
  });

  it("drops an over-long call_id confirm (D1 maxLength 36) before send, logged privacy-safe (finding 4)", async () => {
    const records: FetchRecord[] = [];
    const log = capturingLogger();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch(records, () => new Response(null, { status: 204 })),
    });
    // A structurally valid confirm mutated to violate call_id maxLength 36 (bypasses the
    // schema-parsing makeConfirm helper). The value must never reach the wire or the logs.
    const badConfirm = {
      ...makeConfirm(),
      call_id: `bad-${"x".repeat(40)}`,
    } as BudgetConfirmRequest;
    await expect(reporter._sendConfirm(badConfirm)).resolves.toBe("dropped");

    // Never sent — dropped locally instead of 422ing server-side and stranding the reservation.
    expect(records).toHaveLength(0);
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0]).toContain("reporter.confirm_unserializable:");
    expect(log.warn[0]).toContain("fields=call_id");
    expect(log.warn[0]).toContain("exc_type=");
    // Privacy: the offending value never appears in any log line.
    expect([...log.debug, ...log.info, ...log.warn, ...log.error].join("\n")).not.toContain("xxxx");
  });

  it("validates a well-formed confirm and sends it (finding 4 does not block valid confirms)", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => new Response(null, { status: 204 })),
    });
    await reporter._sendConfirm(makeConfirm({ call_id: testCallId(52) }));
    expect(records).toHaveLength(1);
    expect(records[0]?.url).toBe(CONFIRM_URL);
  });

  // Mutation caught: serializing the raw confirm after validation omits schema
  // defaults, including nested TokenDetails counter defaults.
  it("sends schema-normalized defaults and counters from a raw confirm", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => new Response(null, { status: 204 })),
    });
    const raw = {
      reservation_id: "res-raw",
      model: "gpt-4o",
      provider: "openai",
      call_id: testCallId(53),
      token_details: { input_tokens: 7 },
    } as unknown as BudgetConfirmRequest;

    await expect(reporter._sendConfirm(raw)).resolves.toBe("sent");

    const payload = JSON.parse(records[0]?.body ?? "null");
    expect(payload.modality).toBe("text");
    expect(payload.is_provider_fallback).toBe(false);
    expect(payload.token_details).toEqual({
      input_tokens: 7,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      reasoning_tokens: 0,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
      image_input_tokens: 0,
      image_output_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
      tool_use_input_tokens: 0,
    });
  });

  // Mutation caught: re-reading the caller after safeParse serializes a later
  // getter value rather than the first value accepted by the schema.
  it("reads a confirm getter once and sends its first validated value", async () => {
    const records: FetchRecord[] = [];
    let reads = 0;
    const raw = makeConfirm({ call_id: testCallId(54) });
    Object.defineProperty(raw, "model", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "gpt-first" : "gpt-changed";
      },
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, () => new Response(null, { status: 204 })),
    });

    await expect(reporter._sendConfirm(raw)).resolves.toBe("sent");

    expect(reads).toBe(1);
    expect(JSON.parse(records[0]?.body ?? "null").model).toBe("gpt-first");
  });

  // Mutations caught: reflecting arbitrary thrown names leaks/escapes, while
  // moving breaker admission before projection consumes this recovery probe.
  it.each([
    [
      "null prototype",
      "object",
      () => {
        const thrown = Object.create(null) as { secret: string };
        thrown.secret = "SECRET_CONFIRM_NULL_PROTOTYPE";
        return { thrown, sentinels: [thrown.secret] };
      },
    ],
    [
      "forged constructor name",
      "object",
      () => {
        const thrown = {
          constructor: { name: "SECRET_RAW_VALUE" },
          message: "SECRET_FORGED_MESSAGE",
        };
        return { thrown, sentinels: [thrown.constructor.name, thrown.message] };
      },
    ],
    [
      "hostile Error name accessor",
      "Error",
      () => {
        const thrown = new Error("SECRET_CONFIRM_ERROR_MESSAGE");
        Object.defineProperty(thrown, "name", {
          configurable: true,
          get: () => {
            throw new Error("SECRET_CONFIRM_NAME_ACCESSOR");
          },
        });
        return {
          thrown,
          sentinels: ["SECRET_CONFIRM_ERROR_MESSAGE", "SECRET_CONFIRM_NAME_ACCESSOR"],
        };
      },
    ],
    [
      "revoked proxy",
      "object",
      () => {
        const { proxy, revoke } = Proxy.revocable({ secret: "SECRET_REVOKED_PROXY" }, {});
        revoke();
        return { thrown: proxy, sentinels: ["SECRET_REVOKED_PROXY"] };
      },
    ],
  ] as const)("contains a %s confirm getter throw before recovery-probe admission", async (_label, expectedName, makeThrown) => {
    let breakerNow = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      now: () => breakerNow,
    });
    breaker.recordFailure();
    breakerNow = 1000;
    const before = breaker.getState();
    expect(before).toMatchObject({ state: "open", recoveryEligible: true });

    const records: FetchRecord[] = [];
    const log = argumentCapturingLogger();
    const { thrown, sentinels } = makeThrown();
    const poison = makeConfirm({ call_id: testCallId(55) });
    Object.defineProperty(poison, "model", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw thrown;
      },
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      logger: log.logger,
      fetch: makeFetch(records, () => new Response(null, { status: 204 })),
    });

    let escaped = false;
    let poisonOutcome: string | undefined;
    try {
      poisonOutcome = await reporter._sendConfirm(poison);
    } catch {
      escaped = true;
    }

    expect({ escaped, poisonOutcome }).toEqual({ escaped: false, poisonOutcome: "dropped" });
    expect(breaker.getState()).toEqual(before);
    await expect(reporter._sendConfirm(makeConfirm({ call_id: testCallId(56) }))).resolves.toBe(
      "sent",
    );

    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]?.body ?? "null").call_id).toBe(testCallId(56));
    expect(breaker.getState()).toMatchObject({ state: "closed", recoveryEligible: false });
    expect(log.calls).toContainEqual({
      level: "warn",
      args: [`reporter.confirm_unserializable: fields=<unknown> exc_type=${expectedName}`],
    });
    const args = capturedArguments(log);
    expect(args.some((arg) => arg === thrown)).toBe(false);
    expect(args.some((arg) => typeof arg === "object" && arg !== null)).toBe(false);
    const strings = args.filter((arg): arg is string => typeof arg === "string").join("\n");
    for (const sentinel of sentinels) expect(strings).not.toContain(sentinel);
  });

  it("a confirm 4xx is logged type-only, drains regardless, and does not raise", async () => {
    const log = capturingLogger();
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: makeFetch(records, () => new Response('{"detail":"nope"}', { status: 422 })),
    });
    reporter.reportConfirm(makeConfirm());
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(reporter.confirmQueueSize).toBe(0); // drained, not retried
    expect(log.warn).toContain("reporter.confirm_terminal_status: status=%d");
    expect(log.warn).toContain("reporter.confirm_send_failed: exc_type=TransportHttpError");
    expect(log.warn.join("\n")).not.toContain("nope");
  });

  it("10 consecutive confirm failures escalate the 10th to ERROR with consecutive_failures=10", async () => {
    const log = capturingLogger();
    let now = 0;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      maxSendAttempts: 11,
      retryBackoffBase: 1,
      retryBackoffCap: 1,
      monotonicClock: () => now,
      fetch: makeFetch([], () => new Response("", { status: 500 })),
    });
    reporter.reportConfirm(makeConfirm());
    for (let i = 0; i < 10; i++) {
      await reporter._flushRemaining();
      now += 1;
    }
    expect(log.warn).toHaveLength(9);
    expect(log.error).toHaveLength(1);
    expect(log.error[0]).toBe(
      "reporter.confirm_send_persistent_failure: exc_type=TransportHttpError consecutive_failures=10",
    );
  });

  it("flush sends queued confirms BEFORE metadata events (same call_id ordering)", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: makeFetch(records, (url) =>
        url.endsWith("/metadata/ingest") ? ingest202() : new Response(null, { status: 204 }),
      ),
    });
    reporter.reportConfirm(makeConfirm({ call_id: testCallId(61) }));
    reporter.report(makeEvent({ call_id: testCallId(61) }));
    await reporter._flushRemaining();

    const urls = records.map((r) => r.url);
    expect(urls.indexOf(CONFIRM_URL)).toBeLessThan(urls.indexOf(INGEST_URL));
  });

  it("a settlement enqueued DURING a metadata send waits for the NEXT pass, confirm-first", async () => {
    const records: FetchRecord[] = [];
    let reporter!: MetadataReporter;
    let enqueuedLate = false;
    const fetchImpl = makeFetch(records, (url) => {
      if (url.endsWith("/metadata/ingest")) {
        if (!enqueuedLate) {
          // A stream-completion callback firing mid-POST enqueues a settlement,
          // exactly once, during the first pass's in-flight metadata send.
          enqueuedLate = true;
          reporter.reportSettlement(
            makeConfirm({ call_id: testCallId(62) }),
            makeEvent({ call_id: testCallId(62) }),
          );
        }
        return ingest202();
      }
      return new Response(null, { status: 204 });
    });
    reporter = new MetadataReporter(API_URL, API_KEY, { fetch: fetchImpl });

    reporter.report(makeEvent({ call_id: testCallId(63) }));
    await reporter._flushRemaining();

    // First pass: only the metadata POST; the late settlement is deferred.
    expect(records.map((r) => r.url)).toEqual([INGEST_URL]);
    expect(reporter.settlementQueueSize).toBe(1);

    await reporter._flushRemaining();

    // Second pass: the settlement's confirm precedes its metadata event.
    const secondPass = records.slice(1).map((r) => r.url);
    expect(secondPass).toEqual([CONFIRM_URL, INGEST_URL]);
    expect(reporter.settlementQueueSize).toBe(0);
  });

  it("flush batches N events into ceil(N/batchSize) POSTs in one pass", async () => {
    const records: FetchRecord[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 3,
      fetch: makeFetch(records, () => ingest202()),
    });
    for (let i = 0; i < 5; i++) {
      reporter.report(makeEvent({ call_id: testCallId(i) }));
    }
    await reporter._flushRemaining();
    const ingestCalls = records.filter((r) => r.url === INGEST_URL);
    expect(ingestCalls).toHaveLength(2); // 3 + 2
    expect(JSON.parse(ingestCalls[0]?.body ?? "null")).toHaveLength(3);
    expect(JSON.parse(ingestCalls[1]?.body ?? "null")).toHaveLength(2);
  });

  it("preserves maxInFlight while strict FIFO dispatch remains serial", async () => {
    let active = 0;
    let maxActive = 0;
    let requestCount = 0;
    const requests = Array.from({ length: 5 }, () => {
      let signalStarted!: (body: string) => void;
      let respond!: (response: Response) => void;
      const started = new Promise<string>((resolve) => {
        signalStarted = resolve;
      });
      const response = new Promise<Response>((resolve) => {
        respond = resolve;
      });
      return { started, signalStarted, response, respond };
    });
    const fetchImpl: FetchLike = async (_url, init) => {
      const request = requests[requestCount++];
      if (!request) throw new Error("unexpected metadata batch");
      active += 1;
      maxActive = Math.max(maxActive, active);
      request.signalStarted(String(init?.body));
      try {
        return await request.response;
      } finally {
        active -= 1;
      }
    };
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: fetchImpl,
      batchSize: 1,
      maxInFlight: 2,
    });
    for (let i = 0; i < 5; i++) {
      reporter.report(makeEvent({ call_id: testCallId(i) }));
    }

    const flush = reporter._flushRemaining();
    try {
      // Response-body consumption takes a runtime-dependent number of microtasks.
      // Wait for each dispatch itself, not a fixed number of Promise.resolve turns.
      for (const [index, request] of requests.entries()) {
        const body = await request.started;
        expect(JSON.parse(body)).toMatchObject([{ call_id: testCallId(index) }]);
        expect(active).toBe(1);
        expect(reporter.inFlightCount).toBe(1);
        request.respond(ingest202());
      }
      await expect(flush).resolves.toBe(true);
      expect(requestCount).toBe(5);
      expect(reporter.metadataQueueSize).toBe(0);
      expect(reporter.maxInFlight).toBe(2);
      expect(maxActive).toBe(1);
      expect(reporter.inFlightCount).toBe(0); // counter never leaks
    } finally {
      // A failed concurrency/FIFO assertion must not strand a mocked response.
      for (const request of requests) request.respond(ingest202());
      await flush;
    }
  });

  it("the in-flight counter returns to 0 even when a send fails (finally-guarded)", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: () => Promise.reject(new TypeError("down")),
    });
    reporter.report(makeEvent());
    reporter.reportConfirm(makeConfirm());
    await reporter._flushRemaining();
    expect(reporter.inFlightCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

describe("MetadataReporter — lifecycle", () => {
  it("close() flushes remaining metadata in a final POST and empties the queue", async () => {
    const records: FetchRecord[] = [];
    const { reporter } = healthyReporter(records);
    reporter.report(makeEvent({ call_id: testCallId(71) }));
    reporter.report(makeEvent({ call_id: testCallId(72) }));
    await reporter.close();
    expect(records.filter((r) => r.url === INGEST_URL)).toHaveLength(1);
    expect(reporter.metadataQueueSize).toBe(0);
  });

  it("close() sets the observable shutdown signal", async () => {
    const { reporter } = healthyReporter([]);
    expect(reporter.isShutdown).toBe(false);
    await reporter.close();
    expect(reporter.isShutdown).toBe(true);
  });

  it("close() also flushes a pending confirm-only request", async () => {
    const records: FetchRecord[] = [];
    const { reporter } = healthyReporter(records);
    reporter.reportConfirm(makeConfirm({ call_id: testCallId(73) }));
    await reporter.close();
    expect(records.filter((r) => r.url === CONFIRM_URL)).toHaveLength(1);
  });

  it("reportConfirm/reportSettlement are no-ops once shutdown is signaled", async () => {
    const { reporter } = healthyReporter([]);
    await reporter.close();
    reporter.reportConfirm(makeConfirm());
    reporter.reportSettlement(makeConfirm(), makeEvent());
    expect(reporter.confirmQueueSize).toBe(0);
    expect(reporter.settlementQueueSize).toBe(0);
  });

  it("start() is idempotent and does not throw", () => {
    const { reporter } = healthyReporter([], { flushInterval: 10_000 });
    expect(() => {
      reporter.start();
      reporter.start();
    }).not.toThrow();
    expect(reporter.isShutdown).toBe(false);
  });

  it("Symbol.asyncDispose runs the same close() (await using)", async () => {
    const records: FetchRecord[] = [];
    const { reporter } = healthyReporter(records);
    reporter.report(makeEvent());
    await reporter[Symbol.asyncDispose]();
    expect(reporter.isShutdown).toBe(true);
    expect(records.filter((r) => r.url === INGEST_URL)).toHaveLength(1);
  });

  it("start() then close() drains the loop and performs a final flush", async () => {
    const records: FetchRecord[] = [];
    const { reporter } = healthyReporter(records, { flushInterval: 10_000 });
    reporter.start();
    reporter.report(makeEvent());
    await reporter.close(); // wakes the sleeping loop, then final-flushes
    expect(records.filter((r) => r.url === INGEST_URL)).toHaveLength(1);
    expect(reporter.isShutdown).toBe(true);
  });

  it("unref()s the flush-loop timer so it never keeps the Node event loop alive (F11)", () => {
    // A process that constructs a client and never calls close() must still be able
    // to exit: the re-arming setTimeout must be unref'd. We intercept setTimeout,
    // hand back a fake handle, and assert its unref was invoked exactly once.
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as ReturnType<typeof setTimeout>;
    const spy = vi.spyOn(globalThis, "setTimeout").mockReturnValue(fakeTimer);
    try {
      const { reporter } = healthyReporter([], { flushInterval: 10_000 });
      reporter.start(); // → _runLoop → _sleep → setTimeout(...).unref()
      expect(spy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    // No close(): the fake timer never fires, so the parked loop needs no teardown.
  });
});
