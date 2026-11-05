/**
 * Thin `fetch`-based HTTP transport for the Solwyn Cloud API.
 *
 * Responsibilities (and nothing more):
 * - Normalize the base URL (strip trailing `/`), append the endpoint path.
 * - Attach the auth headers (`Authorization: Bearer <key>`, `Solwyn-Project`, and
 *   `Content-Type: application/json` on bodies) to every request, capturing the project
 *   binding's generation at dispatch so a delayed answer cannot weaken a newer refusal.
 * - Classify every 400/401/403/404 body for an API-key or project refusal and record it on
 *   the binding before the error leaves this module.
 * - Serialize the request body to JSON.
 * - Enforce a per-request timeout via `AbortController` (web-standard; no
 *   `node:*` — edge-safe core).
 * - Surface a typed, PRIVACY-SAFE error on non-2xx / network failure / timeout:
 *   every transport error carries only a class name and (for HTTP errors) a
 *   status code — never a response body or status text. Diagnostic labels come
 *   from trusted type identities, never mutable exception properties.
 * - A bounded retry policy (reporter.md: never a retry-forever loop). Retries
 *   default to OFF (`maxRetries: 0`) because callers such as the reporter own
 *   item-level idempotency, retry, and disposition — a single transport attempt
 *   is the correct default. Retries, when
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

import { classify, isClassifiedStatus, type Refusal } from "./api-key-errors";
import { ConfigurationError } from "./errors";
import { PROJECT_HEADER } from "./types";

/** The exact endpoint paths, relative to the (trailing-slash-stripped) base URL. */
export const BUDGET_CHECK_PATH = "/api/v1/budgets/check";
export const BUDGET_CONFIRM_PATH = "/api/v1/budgets/confirm";
export const LEASE_GRANT_PATH = "/api/v1/budgets/lease";
export const LEASE_RENEW_PATH = "/api/v1/budgets/lease/renew";
export const LEASE_SURRENDER_PATH = "/api/v1/budgets/lease/surrender";
export const METADATA_INGEST_PATH = "/api/v1/metadata/ingest";

/** Minimal structural type of the global `fetch`; injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Endpoint paths extend the configured gateway prefix, including a trailing-slash base. */
export function joinApiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Equal jitter keeps exponential retries bounded while spreading concurrent clients. */
export function retryBackoffDelay(
  attempts: number,
  base: number,
  cap: number,
  random: () => number = Math.random,
): number {
  const bound = Math.min(cap, base * 2 ** Math.min(Math.max(0, attempts - 1), 1023));
  return bound * (0.5 + 0.5 * Math.max(0, Math.min(1, random())));
}

/** Rate-limit responses have a separate finite budget from ordinary send failures. */
export const MAX_RATE_LIMIT_ATTEMPTS = 20;

/** Validate the caller-owned transport seam before any component can start work. */
/** The runtime's global `fetch`, read at call time. The SDK's only executable global fetch read. */
export const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

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
  /** A classified refusal of the API key or its project; allowlisted facts only. */
  readonly refusal: Refusal | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, refusal?: Refusal, retryAfterMs?: number) {
    super(`HTTP ${status}`);
    this.name = "TransportHttpError";
    this.status = status;
    this.refusal = refusal;
    this.retryAfterMs = retryAfterMs;
    transportFailures.set(this, {
      label: "TransportHttpError",
      retryable: status === 408 || status === 429 || status >= 500,
    });
  }
}

/** Parse only retry timing; response text and raw headers never enter diagnostics. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  const delay = /^\d+$/.test(trimmed)
    ? Number(trimmed) * 1000
    : /[A-Za-z]/.test(trimmed)
      ? Date.parse(trimmed) - Date.now()
      : Number.NaN;
  if (Number.isNaN(delay)) return undefined;
  return Math.max(0, Math.min(3_600_000, delay));
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
  /** Project binding: supplies `Solwyn-Project` and receives classified refusals. */
  binding?: RequestBinding;
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
type ResponseConsumer<T> = (
  response: Response,
  discard: () => void,
  generation: number,
) => T | Promise<T>;

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

/** The API-key refusal carried by a transport failure, if any. */
export function apiKeyRefusalOf(error: unknown): Refusal | undefined {
  return error instanceof TransportHttpError ? error.refusal : undefined;
}

/**
 * Read a 400/401/403/404 body, bounded like the discard drain (16 KiB and `boundMs`), and keep
 * only the classified refusal. A body that is too large, stalls past the bound, or fails to read
 * is cancelled (the request is aborted) and classifies as unreadable: every 401 is still a
 * refusal. The text itself is never retained.
 */
async function classifyHttpFailure(
  response: Response,
  controller: AbortController,
  boundMs: number,
): Promise<Refusal | undefined> {
  return classify(response.status, await readBoundedText(response, controller, boundMs));
}

async function readBoundedText(
  response: Response,
  controller: AbortController,
  boundMs: number,
): Promise<string | null> {
  let body: ReadableStream<Uint8Array> | null | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    body = response.body;
    if (body === null || body === undefined) return "";
    reader = body.getReader();
  } catch {
    controller.abort();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.min(Math.max(0, boundMs), DISCARD_DRAIN_MAX_MS));
    (timer as { unref?: () => void })?.unref?.();
  });
  const complete = (async (): Promise<boolean> => {
    for (;;) {
      const result = await reader.read();
      if (result.done) return true;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) return false;
      bytes += value.byteLength;
      if (bytes > DISCARD_DRAIN_MAX_BYTES) return false;
      chunks.push(value);
    }
  })().catch(() => false);
  try {
    if (!(await Promise.race([complete, expired]))) {
      try {
        reader.cancel().catch(() => {});
      } catch {
        // A synchronously throwing cancel still ends in the abort below.
      }
      controller.abort();
      return null;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    return null;
  }
}

/**
 * The project binding a transport reports to. `dispatch` captures the header value and the
 * generation in one step; `refuse` records a classified refusal against that generation.
 */
export interface RequestBinding {
  dispatch(): { readonly header: string; readonly generation: number };
  refuse(refusal: Refusal, dispatched: number): unknown;
  /** Record a blocking refusal the moment a 401 status arrives; returns a refine token. */
  refuseProvisionally(): unknown;
  /** Replace the provisional refusal with the classified one. */
  refine(token: unknown, refusal: Refusal, dispatched: number): void;
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
  private readonly binding: RequestBinding | null;

  constructor(baseUrl: string, apiKey: string, options: TransportOptions = {}) {
    // Strip ALL trailing slashes (Python: `api_url.rstrip("/")`).
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    const injected = options.fetch;
    this.fetchImpl = injected ?? globalFetch;
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.binding = options.binding ?? null;
  }

  /**
   * The request headers and the binding generation they were captured at. Called once per
   * attempt, immediately before the fetch.
   */
  requestHeaders(withBody = true): { headers: Record<string, string>; generation: number } {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (withBody) headers["Content-Type"] = "application/json";
    if (this.binding === null) return { headers, generation: 0 };
    const { header, generation } = this.binding.dispatch();
    headers[PROJECT_HEADER] = header;
    return { headers, generation };
  }

  /** The current request headers (diagnostic and test seam; requests capture their own). */
  authHeaders(): Record<string, string> {
    return this.requestHeaders().headers;
  }

  /**
   * GET `path` and read its JSON body, returning the dispatch generation with it. Non-2xx,
   * timeout and network failures throw the same typed errors as POSTs.
   */
  async getJson(
    path: string,
    options: RequestOptions,
  ): Promise<{ read: JsonBodyReadResult; generation: number }> {
    return this.requestWith("GET", path, undefined, options, async (response, _d, generation) => {
      const text = await response.text();
      try {
        return { read: { parsed: true, value: JSON.parse(text) }, generation };
      } catch (error) {
        return { read: { parsed: false, error }, generation };
      }
    });
  }

  /**
   * POST `body` (JSON-serialized) to `path`. Resolves on any 2xx without reading
   * the body, which is released by a detached, bounded drain. Throws a
   * {@link TransportError} subclass on non-2xx, timeout, or network failure —
   * always privacy-safe (class name + status only).
   */
  async postJson(path: string, body: unknown, options: RequestOptions): Promise<void> {
    return this.requestWith("POST", path, JSON.stringify(body), options, (_response, discard) => {
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
    return this.requestWith("POST", path, JSON.stringify(body), options, async (response) => {
      // Read completion is the boundary between transport I/O and JSON contract drift.
      const text = await response.text();
      try {
        return { parsed: true, value: JSON.parse(text) };
      } catch (error) {
        return { parsed: false, error };
      }
    });
  }

  private async requestWith<T>(
    method: "GET" | "POST",
    path: string,
    payload: string | undefined,
    options: RequestOptions,
    consume: ResponseConsumer<T>,
  ): Promise<T> {
    const url = joinApiUrl(this.baseUrl, path);
    const attempts = this.maxRetries + 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.attempt(method, url, payload, options, consume);
      } catch (error) {
        lastError = error;
        const isLast = attempt === attempts - 1;
        if (isLast || !isRetryableTransportError(error) || options.signal?.aborted) {
          throw error;
        }
        await sleep(
          Math.max(
            this.retryBaseDelayMs * 2 ** attempt,
            error instanceof TransportHttpError ? (error.retryAfterMs ?? 0) : 0,
          ),
          options.signal,
        );
      }
    }
    // Unreachable: the loop either returns or throws.
    throw lastError;
  }

  private async attempt<T>(
    method: "GET" | "POST",
    url: string,
    payload: string | undefined,
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
        // Headers and the dispatch generation are captured together, right before the fetch.
        const { headers, generation } = this.requestHeaders(payload !== undefined);
        const init: RequestInit = { method, headers, signal: controller.signal };
        if (payload !== undefined) init.body = payload;
        const response = await this.fetchImpl(url, init);
        if (abandoned) {
          // An abort-ignoring fetch resolved after the attempt already failed.
          discardResponseBody(response, controller, 0);
          throw new TransportNetworkError("response arrived after the attempt ended");
        }
        if (!response.ok) {
          let retryAfterMs: number | undefined;
          try {
            retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
          } catch {
            // Custom fetch responses may lack a usable headers interface.
          }
          const classified = isClassifiedStatus(response.status);
          // Every 401 refuses, whatever its body: block now, synchronously at the status, so a
          // timeout or cancellation that beats a stalled body can never reach the outage posture.
          const provisional =
            response.status === 401 ? this.binding?.refuseProvisionally() : undefined;
          const refusal = classified
            ? await classifyHttpFailure(response, controller, deadline - monotonicNow())
            : undefined;
          // A classified refusal is recorded before anything else on this request's path.
          if (refusal !== undefined) {
            if (response.status === 401) this.binding?.refine(provisional, refusal, generation);
            else this.binding?.refuse(refusal, generation);
          }
          const failure = new TransportHttpError(response.status, refusal, retryAfterMs);
          httpFailure = failure;
          // The outcome is decided at headers; disposal never delays or changes it.
          // A classified body was consumed by the refusal read; anything else is drained.
          if (!classified) discard(response);
          throw failure;
        }
        return consume(response, () => discard(response), generation);
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
