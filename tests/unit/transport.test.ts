import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_CHECK_PATH,
  BUDGET_CONFIRM_PATH,
  type FetchLike,
  METADATA_INGEST_PATH,
  Transport,
  TransportError,
  TransportHttpError,
  TransportNetworkError,
  TransportTimeoutError,
} from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch that records every call and returns a fixed 200 JSON response. */
function recordingFetch(
  calls: RecordedCall[],
  response: () => Response = () => new Response("{}", { status: 200 }),
): FetchLike {
  return (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(response());
  };
}

/** A fetch that hangs until its signal aborts, then rejects like real fetch. */
function hangingFetch(calls: RecordedCall[]): FetchLike {
  return (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
    });
  };
}

describe("Transport — URL + headers + body", () => {
  it("strips ALL trailing slashes from the base URL", async () => {
    const calls: RecordedCall[] = [];
    const transport = new Transport("https://api.solwyn.ai///", API_KEY, {
      fetch: recordingFetch(calls),
    });
    await transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 1000 });
    expect(calls[0]?.url).toBe("https://api.solwyn.ai/api/v1/metadata/ingest");
  });

  it("leaves a clean base URL untouched", async () => {
    const calls: RecordedCall[] = [];
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: recordingFetch(calls),
    });
    await transport.postJson(BUDGET_CHECK_PATH, {}, { timeoutMs: 1000 });
    expect(calls[0]?.url).toBe("https://api.solwyn.ai/api/v1/budgets/check");
  });

  it("sends exactly the two required auth headers on every request", async () => {
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: recordingFetch([]),
    });
    expect(transport.authHeaders()).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
  });

  it("POSTs with the auth headers and JSON-serialized body", async () => {
    const calls: RecordedCall[] = [];
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: recordingFetch(calls),
    });
    const body = { reservation_id: "r1", call_id: "c1" };
    await transport.postJson(BUDGET_CONFIRM_PATH, body, { timeoutMs: 5000 });

    const call = calls[0];
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
    expect(call?.init.body).toBe(JSON.stringify(body));
  });

  it("serializes a bare JSON array body (ingest) without an envelope", async () => {
    const calls: RecordedCall[] = [];
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: recordingFetch(calls),
    });
    const events = [{ call_id: "a" }, { call_id: "b" }];
    await transport.postJson(METADATA_INGEST_PATH, events, { timeoutMs: 10_000 });
    expect(calls[0]?.init.body).toBe(JSON.stringify(events));
  });

  it("resolves without a value on a 2xx; the unused body is not handed to callers", async () => {
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: recordingFetch(
        [],
        () => new Response('{"ingested":1,"rejected":[]}', { status: 202 }),
      ),
    });
    await expect(
      transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("treats a 204 as success and does not require a body", async () => {
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: recordingFetch([], () => new Response(null, { status: 204 })),
    });
    await expect(
      transport.postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
  });
});

describe("Transport — non-2xx surfacing (D10 generic handling)", () => {
  it.each([
    400, 403, 404, 422, 429, 500, 503,
  ])("throws a privacy-safe TransportHttpError for status %i", async (status) => {
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: recordingFetch(
        [],
        () => new Response('{"detail":"Reservation not found or expired"}', { status }),
      ),
    });

    const error = await transport
      .postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 5000 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransportHttpError);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportHttpError).status).toBe(status);
    expect((error as TransportHttpError).name).toBe("TransportHttpError");
    // The response body / status text must NEVER leak into the error.
    expect((error as Error).message).not.toContain("Reservation");
    expect((error as Error).message).not.toContain("detail");
  });
});

describe("Transport — network + timeout errors", () => {
  it("wraps a raw fetch rejection as a TransportNetworkError (cause retained)", async () => {
    const underlying = new TypeError("fetch failed");
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: () => Promise.reject(underlying),
    });

    const error = await transport
      .postJson(METADATA_INGEST_PATH, [], { timeoutMs: 1000 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransportNetworkError);
    expect((error as TransportNetworkError).name).toBe("TransportNetworkError");
    expect((error as Error).cause).toBe(underlying);
  });

  it("aborts the fetch and throws TransportTimeoutError when the timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const calls: RecordedCall[] = [];
      const transport = new Transport("https://api.solwyn.ai", API_KEY, {
        fetch: hangingFetch(calls),
      });

      const promise = transport
        .postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 5000 })
        .catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(5000);
      const error = await promise;

      expect(error).toBeInstanceOf(TransportTimeoutError);
      expect((error as TransportTimeoutError).timeoutMs).toBe(5000);
      // The signal handed to fetch must have been aborted.
      expect((calls[0]?.init.signal as AbortSignal).aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds successful-response body consumption even when the body ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const response = {
        ok: true,
        status: 202,
        text: () => new Promise<string>(() => {}),
      } as Response;
      const transport = new Transport("https://api.solwyn.ai", API_KEY, {
        fetch: async () => response,
      });
      let settled: unknown;
      void transport
        .postJsonAndReadJson(METADATA_INGEST_PATH, [], { timeoutMs: 50 })
        .catch((error: unknown) => {
          settled = error;
        });

      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(settled).toBeInstanceOf(TransportTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts immediately when an already-aborted external signal is passed", async () => {
    const calls: RecordedCall[] = [];
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: hangingFetch(calls),
    });
    const external = AbortSignal.abort();

    const error = await transport
      .postJson(METADATA_INGEST_PATH, [], { timeoutMs: 10_000, signal: external })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransportError);
    expect((calls[0]?.init.signal as AbortSignal).aborted).toBe(true);
  });

  it("external cancellation bounds an injected fetch that ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const transport = new Transport("https://api.solwyn.ai", API_KEY, {
        fetch: () => new Promise<Response>(() => {}),
      });
      let settled: unknown;
      void transport
        .postJson(METADATA_INGEST_PATH, [], {
          timeoutMs: 10_000,
          signal: controller.signal,
        })
        .catch((error: unknown) => {
          settled = error;
        });

      controller.abort();
      for (let turn = 0; turn < 10 && settled === undefined; turn += 1) {
        await Promise.resolve();
      }

      expect(settled).toBeInstanceOf(TransportNetworkError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Transport — bounded retry policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes exactly ONE attempt by default (no retry) on a retryable failure", async () => {
    let attempts = 0;
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: () => {
        attempts += 1;
        return Promise.resolve(new Response("", { status: 500 }));
      },
    });

    await expect(
      transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(TransportHttpError);
    expect(attempts).toBe(1);
  });

  it("retries transient failures up to maxRetries, then throws the last error", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: () => {
        attempts += 1;
        return Promise.resolve(new Response("", { status: 503 }));
      },
      maxRetries: 2,
      retryBaseDelayMs: 10,
    });

    const promise = transport
      .postJson(METADATA_INGEST_PATH, [], { timeoutMs: 1000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await promise;

    expect(error).toBeInstanceOf(TransportHttpError);
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it("does NOT retry a non-retryable 4xx even when retries are enabled", async () => {
    let attempts = 0;
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: () => {
        attempts += 1;
        return Promise.resolve(new Response("", { status: 400 }));
      },
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });

    await expect(
      transport.postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(TransportHttpError);
    expect(attempts).toBe(1);
  });

  it("retries network errors and can eventually succeed", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const transport = new Transport("https://api.solwyn.ai", API_KEY, {
      fetch: () => {
        attempts += 1;
        if (attempts < 2) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      maxRetries: 3,
      retryBaseDelayMs: 5,
    });

    const promise = transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
