/**
 * Thin `fetch`-based HTTP transport for the Solwyn Cloud API.
 *
 * Responsibilities (and nothing more):
 * - Normalize the base URL (strip trailing `/`), append the endpoint path.
 * - Attach the two required auth headers (`Authorization: Bearer <key>` +
 *   `Content-Type: application/json`) to every request (wire-contract.md).
 * - Serialize the request body to JSON.
 * - Enforce a per-request timeout via `AbortController` (web-standard; no
 *   `node:*` — edge-safe core).
 * - Surface a typed, PRIVACY-SAFE error on non-2xx / network failure / timeout:
 *   every transport error carries only a class name and (for HTTP errors) a
 *   status code — never a response body or status text. Diagnostic labels come
 *   from trusted type identities, never mutable exception properties.
 * - A bounded retry policy (reporter.md: never a retry-forever loop). Retries
 *   default to OFF (`maxRetries: 0`) because callers such as the reporter own
 *   item-level retry/disposition and budget confirm is non-idempotent — a single
 *   transport attempt is the correct default. Retries, when
 *   explicitly enabled, apply only to transient conditions (network error,
 *   timeout, 429, 5xx) and are capped.
 *
 * - Dispose of every response body the SDK does not use, off the result path:
 *   the outcome is decided at headers, and a detached, bounded drain then reads
 *   and discards a small body (keeping the connection reusable) or cancels the
 *   body and aborts the request (releasing the connection). Body bytes are never
 *   decoded, retained, or logged.
 *
 * The `fetch` implementation is injectable so unit tests stay fully offline.
 */

import { ConfigurationError } from "./errors";

/** The exact endpoint paths, relative to the (trailing-slash-stripped) base URL. */
export const BUDGET_CHECK_PATH = "/api/v1/budgets/check";
export const BUDGET_CONFIRM_PATH = "/api/v1/budgets/confirm";
export const LEASE_GRANT_PATH = "/api/v1/budgets/lease";
export const LEASE_RENEW_PATH = "/api/v1/budgets/lease/renew";
export const LEASE_SURRENDER_PATH = "/api/v1/budgets/lease/surrender";
export const METADATA_INGEST_PATH = "/api/v1/metadata/ingest";

/** Minimal structural type of the global `fetch`; injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Validate the caller-owned transport seam before any component can start work. */
export function requireFetchLike(fetch: unknown): asserts fetch is FetchLike | undefined {
  if (fetch !== undefined && typeof fetch !== "function") {
    throw new ConfigurationError("fetch must be a function", { field: "fetch" });
  }
}

// ---------------------------------------------------------------------------
// Typed errors. Names only — never a response body / status text / credential.
// ---------------------------------------------------------------------------

type TransportErrorLabel =
  | "TransportError"
  | "TransportHttpError"
  | "TransportTimeoutError"
  | "TransportNetworkError";

/** Construction-time facts cannot invoke reflection traps or later-mutated getters. */
const transportFailures = new WeakMap<object, { label: TransportErrorLabel; retryable: boolean }>();

function transportFailure(error: unknown) {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? transportFailures.get(error)
    : undefined;
}

/** Internal diagnostic projection; never reads caller-owned name/constructor properties. */
export function transportErrorLabel(error: unknown): TransportErrorLabel | null {
  return transportFailure(error)?.label ?? null;
}

/** Base class for every transport failure. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "TransportError";
    Object.setPrototypeOf(this, new.target.prototype);
    transportFailures.set(this, { label: "TransportError", retryable: false });
  }
}

/**
 * A non-2xx HTTP response. Carries the numeric `status` (a status *code* is not
 * content) but never the response body/status text. The message is a bare
 * `HTTP <status>` so even accidental message logging cannot leak content.
 */
export class TransportHttpError extends TransportError {
  readonly status: number;
  readonly marker: "read_only_key" | undefined;

  constructor(status: number, marker?: "read_only_key") {
    super(`HTTP ${status}`);
    this.name = "TransportHttpError";
    this.status = status;
    this.marker = marker;
    transportFailures.set(this, {
      label: "TransportHttpError",
      retryable: status === 408 || status === 429 || status >= 500,
    });
  }
}

/** The per-request timeout fired (the `AbortController` aborted the fetch). */
export class TransportTimeoutError extends TransportError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "TransportTimeoutError";
    this.timeoutMs = timeoutMs;
    transportFailures.set(this, { label: "TransportTimeoutError", retryable: true });
  }
}

/**
 * A network-level failure (fetch rejected for a reason other than our timeout).
 * The original error is retained as `cause` for debugging but is never logged by
 * the callers — diagnostics use the trusted type label.
 */
export class TransportNetworkError extends TransportError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportNetworkError";
    transportFailures.set(this, { label: "TransportNetworkError", retryable: true });
  }
}

// ---------------------------------------------------------------------------
// Transport.
// ---------------------------------------------------------------------------

/** Construction options for {@link Transport}. */
export interface TransportOptions {
  /** Injectable `fetch` (defaults to `globalThis.fetch`). */
  fetch?: FetchLike;
  /**
   * Max RETRIES (not attempts) for a single request. Default `0` — one attempt,
   * no retry. Retries apply only to transient failures and never exceed this cap
   * (reporter.md: never a retry-forever loop).
   */
  maxRetries?: number;
  /** Base backoff delay in ms; grows exponentially per retry. Default `100`. */
  retryBaseDelayMs?: number;
}

/** Per-request options for {@link Transport.postJson}. */
export interface RequestOptions {
  /** Per-request timeout in ms, enforced via `AbortController`. */
  timeoutMs: number;
  /** Optional external cancellation signal (e.g. an owning client's shutdown). */
  signal?: AbortSignal;
}

type JsonBodyReadResult =
  | { readonly parsed: true; readonly value: unknown }
  | { readonly parsed: false; readonly error: unknown };

/**
 * Reads a successful response. `discard` hands the body to the detached drain;
 * a consumer that does not call it owns the body and must read it fully.
 */
type ResponseConsumer<T> = (response: Response, discard: () => void) => T | Promise<T>;

/** Bytes an unused body may deliver before it is cancelled instead of drained. */
const DISCARD_DRAIN_MAX_BYTES = 16 * 1024;
/** Upper bound on a detached drain; it is further capped by the attempt deadline. */
const DISCARD_DRAIN_MAX_MS = 1000;

function monotonicNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/** Reporter-visible retry classification shared by normal and bounded-final sends. */
export function isRetryableTransportError(error: unknown): boolean {
  return transportFailure(error)?.retryable ?? false;
}

/** Inspect and discard a non-2xx body, retaining only the one allowlisted marker. */
async function sanitizedHttpMarker(response: Response): Promise<"read_only_key" | undefined> {
  if (response.status !== 403) {
    return undefined;
  }
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return undefined;
    }
    const detail = (payload as Record<string, unknown>)["detail"];
    if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
      return undefined;
    }
    return (detail as Record<string, unknown>)["code"] === "read_only_key"
      ? "read_only_key"
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Release a response body the SDK will not use, without ever blocking the caller.
 *
 * A null body (for example a 204) needs nothing. Otherwise the body is read and
 * discarded, chunk by chunk and without decoding, so a small complete body ends
 * normally and its connection stays reusable. A body that exceeds the byte cap,
 * outlives `boundMs`, or fails to read is cancelled (the cancel is never awaited
 * and its rejection is handled) and the request is aborted. The drain is
 * detached: callers never await it and it never rejects.
 */
function discardResponseBody(
  response: Response,
  controller: AbortController,
  boundMs: number,
): void {
  let body: ReadableStream<Uint8Array> | null | undefined;
  try {
    body = response.body;
  } catch {
    controller.abort();
    return;
  }
  if (body === null || body === undefined) {
    return;
  }
  drainBody(body, controller, Math.min(Math.max(0, boundMs), DISCARD_DRAIN_MAX_MS)).catch(() => {});
}

async function drainBody(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  boundMs: number,
): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    // Already locked or disturbed by someone else: only the request can be released.
    controller.abort();
    return;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Cancelling settles any pending read; the cancel itself is never awaited.
      reader.cancel().catch(() => {});
    } catch {
      // A synchronously throwing cancel still ends in the abort below.
    }
    controller.abort();
  };
  const timer = setTimeout(release, boundMs);
  // A drain must never keep the process alive. `unref` is Node-only, so guard the
  // optional call (no-op on web/edge timers).
  (timer as { unref?: () => void })?.unref?.();
  try {
    let bytes = 0;
    while (!released) {
      const result = await reader.read();
      if (result.done) {
        // A body that ended on its own leaves its connection reusable.
        released = true;
        break;
      }
      // Only the size is observed; the chunk itself is dropped immediately.
      const size = (result.value as { byteLength?: unknown } | undefined)?.byteLength;
      bytes += typeof size === "number" && size > 0 ? size : 1;
      if (bytes > DISCARD_DRAIN_MAX_BYTES) release();
    }
  } catch {
    // A read error releases the body and the request.
    release();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class Transport {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(baseUrl: string, apiKey: string, options: TransportOptions = {}) {
    // Strip ALL trailing slashes (Python: `api_url.rstrip("/")`).
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    const injected = options.fetch;
    this.fetchImpl = injected ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
  }

  /** The two required headers, identical on every request. */
  authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * POST `body` (JSON-serialized) to `path`. Resolves on any 2xx without reading
   * the body, which is released by a detached, bounded drain. Throws a
   * {@link TransportError} subclass on non-2xx, timeout, or network failure —
   * always privacy-safe (class name + status only).
   */
  async postJson(path: string, body: unknown, options: RequestOptions): Promise<void> {
    return this.postJsonWith(path, body, options, (_response, discard) => {
      discard();
    });
  }

  /**
   * Budget-check-only response operation: keep the request timeout alive until the
   * successful 2xx body has been fully consumed. A completed body with invalid JSON
   * is returned as a parse result so the budget layer can classify it as contract
   * drift; body-stream I/O and abort failures remain typed transport failures.
   */
  async postJsonAndReadJson(
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<JsonBodyReadResult> {
    return this.postJsonWith(path, body, options, async (response) => {
      // Read completion is the boundary between transport I/O and JSON contract drift.
      const text = await response.text();
      try {
        return { parsed: true, value: JSON.parse(text) };
      } catch (error) {
        return { parsed: false, error };
      }
    });
  }

  private async postJsonWith<T>(
    path: string,
    body: unknown,
    options: RequestOptions,
    consume: ResponseConsumer<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const payload = JSON.stringify(body);
    const attempts = this.maxRetries + 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.attempt(url, payload, options, consume);
      } catch (error) {
        lastError = error;
        const isLast = attempt === attempts - 1;
        if (isLast || !isRetryableTransportError(error) || options.signal?.aborted) {
          throw error;
        }
        await sleep(this.retryBaseDelayMs * 2 ** attempt, options.signal);
      }
    }
    // Unreachable: the loop either returns or throws.
    throw lastError;
  }

  private async attempt<T>(
    url: string,
    payload: string,
    options: RequestOptions,
    consume: ResponseConsumer<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const deadline = monotonicNow() + options.timeoutMs;
    const discard = (response: Response) =>
      discardResponseBody(response, controller, deadline - monotonicNow());
    // Set once the attempt has settled, timed out, or been aborted; a Response
    // that an abort-ignoring fetch delivers afterwards is released immediately.
    let abandoned = false;
    let timedOut = false;
    let httpFailure: TransportHttpError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abandoned = true;
        controller.abort();
        // AbortController is advisory to caller-supplied fetch implementations. A
        // Promise race also bounds slow-drip/body consumers that ignore abort.
        reject(new TransportTimeoutError(options.timeoutMs));
      }, options.timeoutMs);
    });

    const external = options.signal;
    let rejectExternalAbort!: (error: TransportNetworkError) => void;
    const externalAbort = new Promise<never>((_resolve, reject) => {
      rejectExternalAbort = reject;
    });
    const onExternalAbort = () => {
      abandoned = true;
      controller.abort();
      // Injected fetch/body implementations may ignore AbortSignal. The explicit
      // race makes ownership cancellation authoritative and leaves the detached
      // operation observed by Promise.race's installed handlers.
      rejectExternalAbort(new TransportNetworkError("request aborted"));
    };
    if (external) {
      if (external.aborted) {
        onExternalAbort();
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    try {
      const operation = (async () => {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.authHeaders(),
          body: payload,
          signal: controller.signal,
        });
        if (abandoned) {
          // An abort-ignoring fetch resolved after the attempt already failed.
          discardResponseBody(response, controller, 0);
          throw new TransportNetworkError("response arrived after the attempt ended");
        }
        if (!response.ok) {
          const failure = new TransportHttpError(
            response.status,
            await sanitizedHttpMarker(response),
          );
          httpFailure = failure;
          // The outcome is decided at headers; disposal never delays or changes it.
          // A 403 body was consumed by the marker read; anything else is drained.
          if (response.status !== 403) discard(response);
          throw failure;
        }
        return consume(response, () => discard(response));
      })();
      return await Promise.race([operation, timeout, externalAbort]);
    } catch (error) {
      // Only this attempt's own HTTP failure may pass through. The injected fetch
      // can reject with any object, including revoked proxies or transport-error
      // lookalikes; inspecting its prototype/status can itself throw or disclose data.
      if (httpFailure !== undefined && error === httpFailure) {
        throw httpFailure;
      }
      if (timedOut) {
        throw new TransportTimeoutError(options.timeoutMs);
      }
      if (external?.aborted) {
        throw new TransportNetworkError("request aborted", { cause: error });
      }
      throw new TransportNetworkError("network request failed", { cause: error });
    } finally {
      abandoned = true;
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }
}
