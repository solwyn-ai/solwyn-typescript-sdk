/**
 * One `ProjectBinding` per client: the configured project selector, the project id pinned
 * from `GET /api/v1/auth/key`, and every definitive refusal of the key or its project.
 *
 * Every request to the Solwyn API carries `Solwyn-Project` (the pinned id once known, else the
 * selector) and captures the binding's `generation` at dispatch (inside `Transport.attempt`).
 * Mutations are fenced by that dispatch generation, so a delayed response can never clear or
 * weaken a refusal recorded after it was sent:
 *
 * - a validation success applies only when nothing changed since its dispatch;
 * - a refusal may always tighten (`block` replaces `allow_unmetered`), but may relax a stored
 *   `block` only when it was dispatched at or after the stored refusal.
 *
 * The budget layer calls {@link ProjectBinding.gate} first on every path that can let a
 * provider call proceed, and {@link ProjectBinding.exitDecision} on every return of that path,
 * so neither a cached allow, a held lease, an open breaker nor the outage posture can run a
 * call past a refusal.
 */

import {
  type Refusal,
  type RefusalCode,
  type RefusalPosture,
  refusalMessage,
} from "./api-key-errors";
import { ApiKeyRefusedError } from "./errors";
import { bestEffortLogger, type Logger, noopLogger } from "./logging";
import { runOutsideRun } from "./run-context";
import { withoutTraceContext } from "./trace-context";
import { type FetchLike, Transport, TransportHttpError } from "./transport";
import type { AuthKeyResponse } from "./types";
import { AuthKeyResponseSchema } from "./validation";

export const AUTH_KEY_PATH = "/api/v1/auth/key";

/** Retry interval for automatic validation while no `/auth/key` 200 has been seen. */
export const UNVALIDATED_RETRY_MS = 30_000;
/** Retry interval for automatic validation while a refusal is stored. */
export const REFUSED_RETRY_MS = 60_000;

export type BindingState = "unvalidated" | "valid" | "refused";
/** Why retained authority (cached allows, held leases) must be dropped. */
export type AuthorityChange = "refused" | "pinned" | "recovered";
export type RefusalEffect = "block" | "allow_unmetered";

/** A stored refusal, with its effect decided once, at the moment it was recorded. */
export interface StoredRefusal {
  readonly code: RefusalCode;
  readonly posture: RefusalPosture;
  readonly effect: RefusalEffect;
  readonly message: string;
  readonly field: "api_key" | "project";
}

/** What the gate decided for one call. */
export type GateDecision =
  | { readonly kind: "proceed"; readonly generation: number }
  | { readonly kind: "unmetered" };

/** What the exit check decided for one result. */
export type ExitDecision =
  | { readonly kind: "keep" }
  | { readonly kind: "rerun" }
  | { readonly kind: "unmetered" }
  | { readonly kind: "block"; readonly error: ApiKeyRefusedError };

/** The outcome of one `/auth/key` request. */
export type ValidationOutcome = "success" | "ignored" | "refused" | "outage";

export interface ProjectBindingOptions {
  /** The validated, trimmed project selector (a name or a `proj_` id). */
  selector: string;
  apiUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  /** `/auth/key` timeout in milliseconds (the budget check timeout). */
  timeoutMs: number;
  logger?: Logger;
  /** Monotonic clock in milliseconds; injectable for tests. */
  now?: () => number;
}

const BLOCK_RANK: Readonly<Record<RefusalEffect, number>> = { allow_unmetered: 1, block: 2 };

function monotonicNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export class ProjectBinding {
  readonly selector: string;
  readonly #transport: Transport;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #listeners = new Set<(reason: AuthorityChange) => void>();
  readonly #loggedCodes = new Set<string>();

  #pinnedId: string | null = null;
  #lastAuth: AuthKeyResponse | null = null;
  /** Aborted the moment a blocking refusal is stored; replaced once calls may run again. */
  #blockController = new AbortController();
  #state: BindingState = "unvalidated";
  #everValid = false;
  #refusal: StoredRefusal | null = null;
  #generation = 0;
  #refusalGen = 0;
  #nextValidateAt = 0;
  #inflight: Promise<ValidationOutcome> | null = null;

  constructor(options: ProjectBindingOptions) {
    this.selector = options.selector;
    this.#timeoutMs = options.timeoutMs;
    this.#logger = bestEffortLogger(options.logger ?? noopLogger);
    this.#now = options.now ?? monotonicNow;
    // The /auth/key transport does not refuse at a 401's status: its classified body is the
    // answer that may relax a refusal, so it must not first tighten past its own generation.
    this.#transport = new Transport(options.apiUrl, options.apiKey, {
      fetch: options.fetch,
      binding: this,
      refuseAtStatus: false,
      suppressWhileRefused: false,
    });
  }

  get state(): BindingState {
    return this.#state;
  }

  get pinnedId(): string | null {
    return this.#pinnedId;
  }

  get everValid(): boolean {
    return this.#everValid;
  }

  get refusal(): StoredRefusal | null {
    return this.#refusal;
  }

  get generation(): number {
    return this.#generation;
  }

  /** The `Solwyn-Project` header value: the pinned id once known, else the selector. */
  get headerValue(): string {
    return this.#pinnedId ?? this.selector;
  }

  /** Capture the header value and the dispatch generation in one step. */
  dispatch(): { readonly header: string; readonly generation: number } {
    return { header: this.headerValue, generation: this.#generation };
  }

  /**
   * Run `listener` synchronously whenever retained authority must be dropped: a refusal changed
   * the stored state (`refused`), a validation pinned a different project id (`pinned`), or a
   * validation cleared a refusal (`recovered`).
   */
  onAuthorityChange(listener: (reason: AuthorityChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(reason: AuthorityChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(reason);
      } catch {
        // Listeners are best-effort local cleanup; the state change is recorded regardless.
      }
    }
  }

  #effectFor(refusal: Refusal): RefusalEffect {
    return (refusal.code === "api_key_expired" || refusal.code === "api_key_invalid") &&
      refusal.posture === "alert_only" &&
      this.#everValid
      ? "allow_unmetered"
      : "block";
  }

  /**
   * Record a classified refusal from a request dispatched at generation `dispatched`.
   *
   * A refusal may always tighten (no refusal, or `allow_unmetered`, becomes `block`; a block's
   * code and message are replaced by a newer one). It may relax a stored `block` to
   * `allow_unmetered` only when the request was dispatched at or after the stored refusal was
   * recorded, which in practice is the revalidation started when that refusal was recorded. A
   * 401's own body can therefore never relax the block its status recorded. Never throws.
   */
  refuse(refusal: Refusal, dispatched: number): void {
    const effect = this.#effectFor(refusal);
    const stored = this.#refusal;
    if (
      stored !== null &&
      BLOCK_RANK[effect] < BLOCK_RANK[stored.effect] &&
      dispatched < this.#refusalGen
    ) {
      return;
    }
    this.#store(refusal, effect, true);
  }

  /**
   * A 401 status from a data-plane request, before its body is read: unless a refusal is already
   * stored, record a blocking `api_key_invalid` with posture unknown at once (no timeout or
   * cancellation racing a slow body can then reach the outage posture), and revalidate promptly
   * so an alert-only project relaxes as soon as a fresh `/auth/key` answer says so.
   */
  refuseAtStatus(): void {
    // Only a request sent before the current refusal can still answer 401 (nothing else is sent
    // while refused); its status tightens an allow_unmetered refusal for one round trip.
    if (this.#state === "refused" && this.#refusal?.effect === "block") return;
    const unknown: Refusal = { code: "api_key_invalid", posture: "unknown", expiredOn: null };
    this.#store(unknown, "block", false);
    this.#revalidateSoon();
  }

  /**
   * Start a single-flight revalidation now, or right after the one in flight (which was
   * dispatched before the refusal, so it cannot relax it). Never throws.
   */
  #revalidateSoon(): void {
    const start = (): void => {
      if (this.#state === "refused") void this.revalidate();
    };
    const pending = this.#inflight;
    if (pending === null) start();
    else pending.then(start, start);
  }

  #store(refusal: Refusal, effect: RefusalEffect, log: boolean): void {
    const stored = this.#refusal;
    const { message, field } = refusalMessage(refusal, this.selector);
    if (log && !this.#loggedCodes.has(refusal.code)) {
      this.#loggedCodes.add(refusal.code);
      this.#logger.error(`solwyn.configuration_error.${refusal.code}: ${message}`);
    }
    if (
      stored !== null &&
      stored.code === refusal.code &&
      stored.posture === refusal.posture &&
      stored.effect === effect &&
      stored.message === message
    ) {
      return;
    }
    const next: StoredRefusal = Object.freeze({
      code: refusal.code,
      posture: refusal.posture,
      effect,
      message,
      field,
    });
    if (stored !== null && stored.effect === effect) {
      // Same effect, newer wording (for example the body of a 401 whose status already blocked):
      // nothing a caller can observe changes, so the generation and fencing stay where they are.
      this.#refusal = next;
      return;
    }
    this.#nextValidateAt = this.#now() + REFUSED_RETRY_MS;
    this.#refusal = next;
    this.#state = "refused";
    this.#syncBlockSignal();
    this.#generation += 1;
    this.#refusalGen = this.#generation;
    this.#notify("refused");
  }

  /**
   * An `AbortSignal` that aborts as soon as a blocking refusal is stored. Native requests that are
   * dispatched later than the call that started them (async request hooks, stream helpers) carry
   * it, so they never reach the network after a refusal. Calls made after the block lifts get a
   * fresh signal.
   */
  refusalSignal(): AbortSignal {
    return this.#blockController.signal;
  }

  #syncBlockSignal(): void {
    const blocking = this.#state === "refused" && this.#refusal?.effect === "block";
    const aborted = this.#blockController.signal.aborted;
    if (blocking && !aborted) this.#blockController.abort();
    else if (!blocking && aborted) this.#blockController = new AbortController();
  }

  /** The stored refusal while refused, whatever its effect: data-plane requests are not sent. */
  suppressedBy(): Refusal | undefined {
    const refusal = this.#state === "refused" ? this.#refusal : null;
    return refusal === null
      ? undefined
      : { code: refusal.code, posture: refusal.posture, expiredOn: null };
  }

  /**
   * The error to raise before a provider dispatch, when a stored refusal blocks calls; `null`
   * otherwise (no refusal, or one that lets calls run unmetered). Synchronous, no network.
   */
  blockingRefusal(): ApiKeyRefusedError | null {
    const refusal = this.#state === "refused" ? this.#refusal : null;
    return refusal !== null && refusal.effect === "block" ? this.#refusalError(refusal) : null;
  }

  /** Apply a full-scope `/auth/key` 200 dispatched at `dispatched`; false when superseded. */
  #succeed(dispatched: number, auth: AuthKeyResponse): boolean {
    if (dispatched !== this.#generation) return false;
    const pinChanged = this.#pinnedId !== auth.project_id;
    const recovered = this.#state === "refused";
    this.#pinnedId = auth.project_id;
    this.#lastAuth = auth;
    this.#state = "valid";
    this.#everValid = true;
    this.#refusal = null;
    this.#generation += 1;
    this.#syncBlockSignal();
    if (pinChanged) this.#notify("pinned");
    else if (recovered) this.#notify("recovered");
    return true;
  }

  #outage(): ValidationOutcome {
    if (this.#state !== "valid") {
      this.#nextValidateAt =
        this.#now() + (this.#state === "refused" ? REFUSED_RETRY_MS : UNVALIDATED_RETRY_MS);
    }
    return "outage";
  }

  /** One single-flight `GET /api/v1/auth/key`. Never throws. */
  #request(): Promise<ValidationOutcome> {
    if (this.#inflight !== null) return this.#inflight;
    // Shared by every concurrent caller, so it carries no one caller's run scope or trace
    // context: a run-scoped start would keep that run reachable after it finishes.
    const pending = runOutsideRun(() =>
      withoutTraceContext(async (): Promise<ValidationOutcome> => {
        try {
          const { read, generation } = await this.#transport.getJson(AUTH_KEY_PATH, {
            timeoutMs: this.#timeoutMs,
          });
          if (!read.parsed) return this.#outage();
          const parsed = AuthKeyResponseSchema.safeParse(read.value);
          if (!parsed.success) {
            this.#logger.debug("solwyn.auth_key_response_unreadable");
            return this.#outage();
          }
          if (parsed.data.scope !== "full") {
            this.refuse({ code: "read_only_key", posture: "unknown", expiredOn: null }, generation);
            return "refused";
          }
          return this.#succeed(generation, parsed.data) ? "success" : "ignored";
        } catch (error) {
          if (error instanceof TransportHttpError && error.refusal !== undefined) {
            // Transport.attempt already recorded it with this request's dispatch generation.
            this.#nextValidateAt = this.#now() + REFUSED_RETRY_MS;
            return "refused";
          }
          return this.#outage();
        }
      }),
    );
    const tracked = pending.finally(() => {
      if (this.#inflight === tracked) this.#inflight = null;
    });
    this.#inflight = tracked;
    return tracked;
  }

  /** Automatic validation from the gate: records the outcome, never throws. */
  async revalidate(): Promise<ValidationOutcome> {
    try {
      return await this.#request();
    } catch {
      return this.#outage();
    }
  }

  /**
   * Public validation: one `/auth/key` request (joining one already in flight). Resolves with the
   * key's details when the key is valid for the project (the pinned answer, if this one was
   * superseded), or `null` when Solwyn could not be reached: nothing changes and calls keep
   * following `failOpen`. Throws {@link ApiKeyRefusedError} on any refusal, any posture.
   */
  async validate(): Promise<AuthKeyResponse | null> {
    await this.#request();
    const refusal = this.#state === "refused" ? this.#refusal : null;
    if (refusal !== null) throw this.#refusalError(refusal);
    return this.#state === "valid" ? this.#lastAuth : null;
  }

  #refusalError(refusal: StoredRefusal): ApiKeyRefusedError {
    return new ApiKeyRefusedError(refusal.message, { code: refusal.code, field: refusal.field });
  }

  #apply(refusal: StoredRefusal): { kind: "unmetered" } {
    if (refusal.effect === "block") throw this.#refusalError(refusal);
    this.#logger.error(
      `solwyn.api_key_refused: ${refusal.code}; the call runs unmetered because the project is alert_only. ${refusal.message}`,
    );
    return { kind: "unmetered" };
  }

  /**
   * Entry gate, first on every path that can let a provider call proceed. Revalidates when due
   * (never throws for that), then applies a stored refusal: `block` throws
   * {@link ApiKeyRefusedError}, `allow_unmetered` returns `unmetered`. Otherwise returns the
   * generation the exit check compares against.
   */
  async gate(): Promise<GateDecision> {
    if (this.#revalidationDue()) await this.revalidate();
    return this.#decide();
  }

  /**
   * The gate without a suspension point: `undefined` when a revalidation is due (call
   * {@link gate}); otherwise the same decision {@link gate} would make, synchronously, so a
   * valid client's check keeps its synchronous dispatch prefix.
   */
  gateNow(): GateDecision | undefined {
    return this.#revalidationDue() ? undefined : this.#decide();
  }

  #revalidationDue(): boolean {
    return this.#state !== "valid" && this.#now() >= this.#nextValidateAt;
  }

  #decide(): GateDecision {
    const refusal = this.#state === "refused" ? this.#refusal : null;
    if (refusal !== null) return this.#apply(refusal);
    return { kind: "proceed", generation: this.#generation };
  }

  /**
   * Exit check for a result produced after the gate returned `generation`. A refusal or a
   * generation change discards the result: `block` and `unmetered` apply the stored refusal,
   * `rerun` (a successful revalidation moved the generation) re-runs the check once.
   */
  exitDecision(generation: number): ExitDecision {
    const refusal = this.#state === "refused" ? this.#refusal : null;
    if (refusal !== null) {
      if (refusal.effect === "block") return { kind: "block", error: this.#refusalError(refusal) };
      this.#logger.error(
        `solwyn.api_key_refused: ${refusal.code}; the call runs unmetered because the project is alert_only. ${refusal.message}`,
      );
      return { kind: "unmetered" };
    }
    if (this.#generation !== generation) return { kind: "rerun" };
    return { kind: "keep" };
  }
}
