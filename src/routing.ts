/**
 * Pure, sans-I/O routing / failover-policy core (M4).
 *
 * Two independent responsibilities, both pure (no I/O, no provider SDKs, no cost math):
 *
 *  1. **Candidate ordering** — a {@link SelectionPolicy} takes the immutable
 *     {@link ProviderCandidate} snapshots for one logical call and returns them in
 *     attempt order. `order()` NEVER mutates a breaker (candidates carry non-mutating
 *     state/recovery-eligibility *snapshots*, never a breaker reference), and the health
 *     tier (CLOSED < HALF_OPEN < recovery-eligible OPEN) ALWAYS dominates the
 *     latency/price/translatability tiebreak.
 *
 *  2. **Transport-exception classification** — {@link classifyException} maps an
 *     arbitrary thrown value to a {@link Disposition} using a load-bearing, narrowest-
 *     first branch order (the `APITimeoutError`-before-`APIConnectionError` double-spend
 *     trap), duck-typed by constructor-name chain + `.status`/`.code` shape with zero
 *     provider-SDK imports. {@link retryAfterSeconds} parses a 429's `Retry-After`.
 *
 * Plus the *pure data/logic* the one async `Solwyn` client's dispatch loop consumes:
 * the chain {@link Deadline}, the compatibility-only shrinking-timeout helper, the
 * same-provider retry margin, the disposition→breaker-verdict map, idempotency-mode
 * resolution and the per-provider {@link LatencyTracker}. The
 * dispatch walk itself lives in `client.ts` and consumes this surface.
 *
 * Ports `solwyn/_routing.py` + `solwyn/providers/_errors.py` (classification). NEVER
 * touches prompt/response content: every field here is structural/numeric/enum metadata,
 * and `classifyException`/`retryAfterSeconds` read only a class name, a numeric status,
 * and a `Retry-After` header — never `String(exc)` / `exc.message`.
 */

import { z } from "zod";
import type { CircuitState } from "./types";
import { ProviderNameSchema } from "./validation";

export type { FailoverReason } from "./types";
// Re-export the failover-reason enum (owned by types.ts) as part of this subsystem's
// clean public surface — the dispatch loop stamps it onto success/telemetry events.
export { FAILOVER_REASONS } from "./types";

// ---------------------------------------------------------------------------
// Candidate + request shapes.
// ---------------------------------------------------------------------------

/**
 * The minimal, identity-comparable view routing needs of a provider runtime. The real
 * `ProviderRuntime` (registry-owned) is structurally assignable to this. Routing reads
 * ONLY `adapter.name` (attribution) and `adapter.dialect` (wire shape) — never any other
 * field — and {@link SelectionPolicy.order} never reads it at all (it is compared by
 * reference identity only, in the client's defensive foreign-runtime filter).
 */
export interface RoutingRuntime {
  readonly adapter: {
    readonly name: string;
    readonly dialect: string;
  };
}

/**
 * Immutable snapshot for ordering ONE configured provider/model link. Carries
 * non-mutating breaker reads (`breakerState`, `recoveryEligible`) — never a breaker
 * reference — so a policy physically cannot flip breaker state by ordering candidates.
 * Frozen at construction ({@link buildCandidate}) for a real runtime-immutability
 * guarantee (Python's frozen dataclass parity).
 */
export interface ProviderCandidate {
  /** Opaque, identity-compared runtime reference. Never read by policies. */
  readonly runtime: RoutingRuntime;
  readonly breakerState: CircuitState;
  readonly recoveryEligible: boolean;
  /** Forward-looking per-target translatability seam — always `true` today (see #4). */
  readonly translatable: boolean;
  /** Server-provided relative price signal (not a currency amount). `null` = unknown. */
  readonly priceHint?: number | null;
  /** Observed p50 latency (ms). `null` = under-sampled / never observed. */
  readonly latencyP50?: number | null;
}

/**
 * Strict routing request. Extra keys are rejected (`extra="forbid"` parity);
 * `estimatedInputTokens` defaults to `0`. NOTE: no policy performs arithmetic combining
 * `estimatedInputTokens` with any price hint — it is carried for future policies only.
 */
export const RoutingRequestSchema = z.strictObject({
  requestedProvider: ProviderNameSchema,
  estimatedInputTokens: z.number().int().nonnegative().default(0),
});
export type RoutingRequest = z.infer<typeof RoutingRequestSchema>;

// ---------------------------------------------------------------------------
// Selection policies.
// ---------------------------------------------------------------------------

/**
 * Structural policy protocol (any object with a matching `order` satisfies it). Pure,
 * synchronous, no I/O. Returning `[]` means "all candidates unusable." MUST NOT mutate
 * the input array or any breaker.
 */
export interface SelectionPolicy {
  /** Whether candidate construction must read observed p50 latency (absent = yes for compatibility). */
  readonly consumesLatencySignals?: boolean;
  /** Whether candidate construction must read server price hints (absent = yes for compatibility). */
  readonly consumesPriceSignals?: boolean;
  order(candidates: readonly ProviderCandidate[], req: RoutingRequest): ProviderCandidate[];
}

/** Health-tier priority: CLOSED best, then HALF_OPEN, then (recovery-eligible) OPEN. */
const STATE_PRIORITY: Record<CircuitState, number> = {
  closed: 0,
  half_open: 1,
  open: 2,
};

/**
 * The shared health filter: drop any candidate that is OPEN and NOT recovery-eligible.
 * Every other candidate (CLOSED, HALF_OPEN, recovery-eligible OPEN) is kept.
 */
function healthUsable(c: ProviderCandidate): boolean {
  return !(c.breakerState === "open" && c.recoveryEligible === false);
}

/** `null`/`undefined` numeric key → `+Infinity` (sorts strictly after every known value). */
function numericOrInfinity(v: number | null | undefined): number {
  return v === null || v === undefined ? Number.POSITIVE_INFINITY : v;
}

/**
 * The one ordering primitive every policy shares: health-filter, then sort by
 * `(statePriority, key ascending with null→+Infinity, !translatable)` with a STABLE sort
 * so configured input order is preserved on a full tie. The state tier ALWAYS dominates
 * the numeric key and translatability. `HealthBasedPolicy` passes `key = () => null`
 * (every key `+Infinity`), so it collapses to `(statePriority, !translatable, stable)` —
 * which is exactly what `CostPolicy`/`LatencyPolicy` produce when NO candidate carries a
 * hint (guaranteeing the byte-identical health-order fallback, #11).
 */
function orderByHealthThenNumeric(
  candidates: readonly ProviderCandidate[],
  key: (c: ProviderCandidate) => number | null | undefined,
): ProviderCandidate[] {
  // `filter` allocates a fresh array — the input array is never mutated by the sort.
  return candidates.filter(healthUsable).sort((a, b) => {
    const stateDiff = STATE_PRIORITY[a.breakerState] - STATE_PRIORITY[b.breakerState];
    if (stateDiff !== 0) {
      return stateDiff;
    }
    const ka = numericOrInfinity(key(a));
    const kb = numericOrInfinity(key(b));
    if (ka !== kb) {
      return ka < kb ? -1 : 1;
    }
    return (a.translatable ? 0 : 1) - (b.translatable ? 0 : 1);
  });
}

/** Default policy: pure health tiering (CLOSED < HALF_OPEN < recovery-eligible OPEN). */
export class HealthBasedPolicy implements SelectionPolicy {
  readonly consumesLatencySignals = false as const;
  readonly consumesPriceSignals = false as const;

  order(candidates: readonly ProviderCandidate[], _req: RoutingRequest): ProviderCandidate[] {
    return orderByHealthThenNumeric(candidates, () => null);
  }
}

/** Orders by ascending observed p50 latency WITHIN each health tier (null p50 last). */
export class LatencyPolicy implements SelectionPolicy {
  readonly consumesLatencySignals = true as const;
  readonly consumesPriceSignals = false as const;

  order(candidates: readonly ProviderCandidate[], _req: RoutingRequest): ProviderCandidate[] {
    return orderByHealthThenNumeric(candidates, (c) => c.latencyP50);
  }
}

/**
 * Orders by ascending server price hint WITHIN each health tier (null hint last).
 * Provably relative-only: only the SIGN of the pairwise hint comparison matters (scale-
 * invariant), and it performs NO arithmetic combining the hint with token counts.
 */
export class CostPolicy implements SelectionPolicy {
  readonly consumesLatencySignals = false as const;
  readonly consumesPriceSignals = true as const;

  order(candidates: readonly ProviderCandidate[], _req: RoutingRequest): ProviderCandidate[] {
    return orderByHealthThenNumeric(candidates, (c) => c.priceHint);
  }
}

// ---------------------------------------------------------------------------
// Candidate helpers (consumed by the client's `_selectCandidates`).
// ---------------------------------------------------------------------------

/**
 * Build one frozen {@link ProviderCandidate} from a runtime + a NON-mutating breaker
 * snapshot (`getState()`-shaped) + the per-runtime latency/price signals. `translatable`
 * is always `true` (#4 — a forward-looking seam, never demoted; untranslatable cross-
 * provider hops are eager-aborted upstream, never demoted in ordering).
 */
export function buildCandidate(
  runtime: RoutingRuntime,
  breakerSnapshot: { state: CircuitState; recoveryEligible: boolean },
  latencyP50: number | null,
  priceHint: number | null,
): ProviderCandidate {
  return Object.freeze({
    runtime,
    breakerState: breakerSnapshot.state,
    recoveryEligible: breakerSnapshot.recoveryEligible,
    translatable: true,
    latencyP50,
    priceHint,
  });
}

/** The provider attribution name of a candidate's runtime (`adapter.name`). */
export function providerNameOf(c: ProviderCandidate): string {
  return c.runtime.adapter.name;
}

/**
 * Defensive filter (#38): keep only candidates whose `runtime` is REFERENCE-identical to
 * one of the client's own configured runtimes, in case a custom-injected policy fabricated
 * or injected a foreign candidate. Preserves the surviving subset's relative order exactly.
 */
export function dropForeignCandidates(
  candidates: readonly ProviderCandidate[],
  validRuntimes: Iterable<RoutingRuntime>,
): ProviderCandidate[] {
  const valid = validRuntimes instanceof Set ? validRuntimes : new Set(validRuntimes);
  return candidates.filter((c) => valid.has(c.runtime));
}

/**
 * The same-provider subset of a candidate list (`"never"` idempotency filters to this).
 * Preserves relative order; matches on `runtime.adapter.name` (attribution axis).
 */
export function sameProviderCandidates(
  candidates: readonly ProviderCandidate[],
  providerName: string,
): ProviderCandidate[] {
  return candidates.filter((c) => providerNameOf(c) === providerName);
}

// ---------------------------------------------------------------------------
// Disposition + transport-exception classification.
// ---------------------------------------------------------------------------

/**
 * How the dispatch loop reacts to a thrown attempt. Exact wire-string values:
 *  - `FAILOVER` — provably safe to try the next provider (pre-send / 429·529).
 *  - `POST_SEND_AMBIGUOUS` — request MAY have reached the model; only crosses under
 *    `"always"` idempotency, but still counts as a breaker health signal.
 *  - `FAIL_FAST` — request-shaped; stop the chain, re-raise, and DO NOT touch the breaker.
 */
export const Disposition = {
  FAILOVER: "failover",
  POST_SEND_AMBIGUOUS: "post_send_ambiguous",
  FAIL_FAST: "fail_fast",
} as const;
export type Disposition = (typeof Disposition)[keyof typeof Disposition];

/** Constructor-name sets whose membership is load-bearing (see `classifyException`). */
const PRE_SEND_NAMES = new Set<string>([
  // httpx pre-send transport classes (fire before any byte is sent).
  "ConnectTimeout",
  "PoolTimeout",
  "ConnectError",
  // botocore / Bedrock pre-send names.
  "EndpointConnectionError",
  "ConnectTimeoutError",
  "ProxyConnectionError",
]);

/**
 * Node `error.code` string values that PROVE a pre-send failure (the connection never
 * established / DNS never resolved), read off any link of an `APIConnectionError` cause chain.
 * The real `openai`/`@anthropic-ai/sdk` npm SDKs wrap a fetch rejection as
 * `APIConnectionError({ cause: TypeError("fetch failed") })` whose `cause.cause` is the Node
 * system error carrying one of these codes — so the pre-send signal lives DEEP in the chain.
 */
const PRE_SEND_CODES = new Set<string>([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * `error.code` values that are post-send-POSSIBLE (bytes may have reached the model): a
 * connection reset can fire after the request was sent, so an `ECONNRESET`-only chain stays
 * ambiguous, never pre-send failover.
 */
const POST_SEND_CODES = new Set<string>(["ECONNRESET"]);

/**
 * Cause-chain constructor names that are post-send-POSSIBLE (a read/write phase timeout implies
 * bytes were already sent). Keeps an `APIConnectionError` wrapping one of these ambiguous.
 */
const AMBIGUOUS_TRANSPORT_NAMES = new Set<string>([
  "TimeoutException",
  "TimeoutError",
  "AbortError",
  "ReadTimeout",
  "WriteTimeout",
  "ReadTimeoutError",
  "TransportError",
  "RemoteProtocolError",
  "ProtocolError",
  "ReadError",
  "WriteError",
  "ProxyError",
  "LocalProtocolError",
  "ModelTimeoutException",
  "ModelErrorException",
  "ConnectionClosedError",
]);

/** Max links to inspect while walking an `APIConnectionError` cause chain (cycle/DoS guard). */
const MAX_CAUSE_DEPTH = 4;
const MAX_CAUSE_NODES = 32;
const MAX_ERROR_PROTOTYPES = 16;

/**
 * Collect the thrown value's type names: its own `.name` (many SDKs — incl. AWS SDK v3 —
 * set `.name` to the error type without a distinct class), plus every `constructor.name`
 * up the prototype chain (stopping before `Object.prototype`). The TS analogue of Python's
 * `{cls.__name__ for cls in type(exc).__mro__}` MRO-name walk. Handles non-object throws
 * (string/number/null) by returning an empty set → the safe `FAIL_FAST` default.
 */
function errorTypeNames(exc: unknown): Set<string> {
  const names = new Set<string>();
  if (exc === null || typeof exc !== "object") {
    return names;
  }
  const own = (exc as { name?: unknown }).name;
  if (typeof own === "string" && own.length > 0) {
    names.add(own);
  }
  let proto: object | null = Object.getPrototypeOf(exc);
  const seen = new Set<object>();
  while (proto !== null && proto !== Object.prototype) {
    if (seen.has(proto) || seen.size >= MAX_ERROR_PROTOTYPES) return new Set();
    seen.add(proto);
    const ctor = (proto as { constructor?: { name?: unknown } }).constructor;
    if (ctor && typeof ctor.name === "string" && ctor.name.length > 0) {
      names.add(ctor.name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

/** A genuine finite number — NOT a boolean/coercible truthy value (bool guard). */
function isNumericStatus(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Read the HTTP status, in priority order:
 *  1. `.status` (real `openai`/`@anthropic-ai/sdk` npm SDKs), `.statusCode`, `.status_code`;
 *  2. `.code` (Google `APIError`);
 *  3. botocore-shaped `response.ResponseMetadata.HTTPStatusCode` (nested);
 *  4. AWS SDK v3-shaped `$metadata.httpStatusCode` (the smithy `ServiceException` shape — the
 *     ONLY place a v3 `bedrock-runtime` error such as `ThrottlingException` carries its status;
 *     none of the direct `.status*`/`.code` keys exist on a v3 exception, so this branch is what
 *     makes Bedrock 429/5xx classify and same-provider 429 retry work at all).
 * A boolean is NEVER read as a status (must be a genuine `number`).
 */
function readStatus(exc: unknown): number | null {
  if (exc === null || typeof exc !== "object") {
    return null;
  }
  const o = exc as Record<string, unknown>;
  for (const key of ["status", "statusCode", "status_code", "code"]) {
    if (isNumericStatus(o[key])) {
      return o[key] as number;
    }
  }
  const resp = o["response"];
  if (resp !== null && typeof resp === "object") {
    const meta = (resp as Record<string, unknown>)["ResponseMetadata"];
    if (meta !== null && typeof meta === "object") {
      const code = (meta as Record<string, unknown>)["HTTPStatusCode"];
      if (isNumericStatus(code)) {
        return code;
      }
    }
  }
  const meta3 = o["$metadata"];
  if (meta3 !== null && typeof meta3 === "object") {
    const code = (meta3 as Record<string, unknown>)["httpStatusCode"];
    if (isNumericStatus(code)) {
      return code;
    }
  }
  return null;
}

/** The chained cause (`err.cause`), or `undefined` when there is none to inspect. */
function getCause(exc: unknown): unknown {
  if (exc === null || typeof exc !== "object") {
    return undefined;
  }
  const cause = (exc as { cause?: unknown }).cause;
  return cause === null || cause === undefined ? undefined : cause;
}

/**
 * Walk an `APIConnectionError`'s cause CHAIN (bounded depth, cycle-guarded, descending into
 * `AggregateError.errors`) to decide pre- vs post-send. The real openai/anthropic npm SDKs nest
 * the discriminating signal one or two links below the wrapper (`APIConnectionError` →
 * `TypeError("fetch failed")` → a Node system error carrying `.code`), so a single-level cause
 * read misclassifies a hard-down primary as ambiguous and never fails over.
 *
 * A chain classifies FAILOVER only when a link proves a pre-send name or code. Ambiguous transport
 * names/codes and otherwise uncertain causes remain POST_SEND_AMBIGUOUS. Every independent
 * aggregate member must itself prove pre-send; an unknown sibling vetoes failover. NEVER reads `.message`
 * (privacy) — only constructor names and the structural `.code` string.
 */
function classifyApiConnectionCause(root: unknown): Disposition {
  type CauseProof = { preSend: boolean; ambiguous: boolean };
  const unknown: CauseProof = { preSend: false, ambiguous: false };
  const uncertain: CauseProof = { preSend: false, ambiguous: true };
  const visiting = new Set<unknown>();
  const proofs = new Map<unknown, CauseProof>();
  let inspected = 0;
  const inspect = (node: unknown, depth: number): CauseProof => {
    if (node === null || typeof node !== "object" || visiting.has(node)) return unknown;
    if (depth > MAX_CAUSE_DEPTH) return uncertain;
    const cached = proofs.get(node);
    if (cached !== undefined) return cached;
    if (inspected++ >= MAX_CAUSE_NODES) return uncertain;
    visiting.add(node);
    let preSend = false;
    let ambiguous = false;
    for (const name of errorTypeNames(node)) {
      preSend ||= PRE_SEND_NAMES.has(name);
      ambiguous ||= AMBIGUOUS_TRANSPORT_NAMES.has(name);
    }
    const code = (node as { code?: unknown }).code;
    if (typeof code === "string") {
      preSend ||= PRE_SEND_CODES.has(code);
      ambiguous ||= POST_SEND_CODES.has(code);
    }
    const cause = (node as { cause?: unknown }).cause;
    if (cause !== null && cause !== undefined) {
      const proof = inspect(cause, depth + 1);
      preSend ||= proof.preSend;
      ambiguous ||= proof.ambiguous;
    }
    const errors = (node as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      if (errors.length === 0 || errors.length > MAX_CAUSE_NODES) return uncertain;
      for (const inner of errors) {
        const proof = inspect(inner, depth + 1);
        preSend ||= proof.preSend;
        // Aggregate members are independent attempts. One refusal cannot prove
        // that an unknown sibling was also rejected before provider work began.
        ambiguous ||= proof.ambiguous || !proof.preSend;
      }
    }
    visiting.delete(node);
    const proof = { preSend, ambiguous };
    proofs.set(node, proof);
    return proof;
  };
  const proof = inspect(root, 0);
  return proof.preSend && !proof.ambiguous ? Disposition.FAILOVER : Disposition.POST_SEND_AMBIGUOUS;
}

/**
 * Classify an arbitrary thrown value into a {@link Disposition}. The certainty-first branch order
 * is load-bearing because provider SDKs attach inheritance and status that can conflict:
 *
 *  1. `APITimeoutError` / `APIConnectionTimeoutError` inspect their bounded cause chain. Only a
 *     proven connect/pool/refusal name or code fails over; bare, read/write, arbitrary `TypeError`,
 *     and otherwise uncertain causes stay post-send ambiguous.
 *  2. Recognized top-level transport certainty precedes status: provably pre-send names fail over,
 *     while timeout/read/write/transport/protocol families stay post-send ambiguous. Native fetch
 *     TypeError causes use bounded positive pre-send proof; uncertain causes stay ambiguous.
 *  3. Numeric status then applies: `429`/`529` fail over, ordinary `4xx` fail fast, and `5xx`
 *     remain post-send ambiguous.
 *  4. `APIConnectionError` uses the same bounded, cycle-safe cause proof; a bare wrapper keeps the
 *     canonical failover default, while read/uncertain causes remain ambiguous.
 *  5. Anything unrecognized, including non-Error throws, fails fast.
 *
 * The bare name `"ConnectionError"` is DELIBERATELY absent from every set (#15): it
 * collides with the JS/Node connection-reset built-in, whose post-send-possible reset must
 * classify FAIL_FAST (the safe default), not pre-send FAILOVER.
 */
export function classifyException(exc: unknown): Disposition {
  try {
    return classifyInspectableException(exc);
  } catch {
    // Error decoration is caller/provider controlled. Inspection must never replace
    // the thrown value or strand its admission with a secondary exception.
    return Disposition.FAIL_FAST;
  }
}

function classifyInspectableException(exc: unknown): Disposition {
  const names = errorTypeNames(exc);

  // Step 1 — timeout wrappers require positive cause proof; uncertainty remains ambiguous.
  if (names.has("APITimeoutError") || names.has("APIConnectionTimeoutError")) {
    const cause = getCause(exc);
    return cause === undefined
      ? Disposition.POST_SEND_AMBIGUOUS
      : classifyApiConnectionCause(cause);
  }
  // Step 2a — provably pre-send (connection never established) → safe to failover.
  for (const name of names) {
    if (PRE_SEND_NAMES.has(name)) {
      return Disposition.FAILOVER;
    }
  }
  // Step 2b — recognized post-send-possible transport families override attached status.
  for (const name of names) {
    if (AMBIGUOUS_TRANSPORT_NAMES.has(name)) {
      return Disposition.POST_SEND_AMBIGUOUS;
    }
  }
  // Native fetch (including @google/genai) preserves TypeError + structural cause.
  // The cause's transport certainty also takes precedence over any attached status.
  if (names.has("TypeError")) {
    const cause = getCause(exc);
    if (cause !== undefined) return classifyApiConnectionCause(cause);
  }
  // Step 3 — numeric HTTP status after transport certainty.
  const status = readStatus(exc);
  if (status !== null) {
    if (status === 429 || status === 529) {
      return Disposition.FAILOVER;
    }
    if (status >= 400 && status < 500) {
      return Disposition.FAIL_FAST;
    }
    if (status >= 500 && status < 600) {
      return Disposition.POST_SEND_AMBIGUOUS;
    }
    // Any other numeric status (1xx/2xx/3xx/≥600) falls through to the cause/default logic.
  }
  // Step 4 — bare/wrapped connection error: the cause CHAIN decides pre- vs post-send.
  if (names.has("APIConnectionError")) {
    const cause = getCause(exc);
    if (cause === undefined) {
      // Bare wrapper (no inspectable cause) = canonical connect-refused outage → failover.
      return Disposition.FAILOVER;
    }
    return classifyApiConnectionCause(cause);
  }
  // Step 5 — unrecognized: safe default, never failover into the unknown.
  return Disposition.FAIL_FAST;
}

// ---------------------------------------------------------------------------
// Retry-After parsing.
// ---------------------------------------------------------------------------

/** Case-insensitive `Retry-After` lookup across Headers-like / Map / plain-dict carriers. */
function getHeaderCaseInsensitive(carrier: unknown, name: string): string | null {
  if (carrier === null || carrier === undefined) {
    return null;
  }
  const lower = name.toLowerCase();
  // A `Map` carrier is iterated case-INSENSITIVELY. This MUST precede the generic `.get()`
  // fast-path below: every `Map` exposes a `.get` method whose lookup is case-SENSITIVE, so a
  // Map falling into the `.get` branch would silently miss a canonically-cased key (e.g.
  // `"Retry-After"`) and return `null`, skipping the same-provider 429 retry (#16/#18). fetch
  // `Headers` is NOT a `Map`, so its case-insensitive `.get` fast-path is unaffected.
  if (carrier instanceof Map) {
    for (const [k, v] of carrier.entries()) {
      if (typeof k === "string" && k.toLowerCase() === lower) {
        return typeof v === "string" ? v : v == null ? null : String(v);
      }
    }
    return null;
  }
  // fetch `Headers` (case-insensitive `.get`) or any `.get(name)`-shaped carrier.
  const getter = (carrier as { get?: unknown }).get;
  if (typeof getter === "function") {
    const got = (getter as (n: string) => unknown).call(carrier, name);
    if (typeof got === "string") {
      return got;
    }
    if (typeof got === "number") {
      return String(got);
    }
    return null;
  }
  if (typeof carrier === "object") {
    for (const [k, v] of Object.entries(carrier as Record<string, unknown>)) {
      if (k.toLowerCase() === lower) {
        return typeof v === "string" ? v : v == null ? null : String(v);
      }
    }
  }
  return null;
}

/**
 * Read the `Retry-After` header value from (in order): `response.headers`, `headers` on
 * the exception itself, AWS SDK v3's `$response.headers` (the smithy `HttpResponse` shape a
 * v3 `ThrottlingException` carries — a plain lowercased-key object), then botocore
 * `response.ResponseMetadata.HTTPHeaders`. A throwing accessor anywhere is SWALLOWED and
 * treated as "no header" (`null`) — never propagated, so it can never mask the original
 * exception.
 */
function readRetryAfterHeader(exc: unknown): string | null {
  if (exc === null || typeof exc !== "object") {
    return null;
  }
  const o = exc as Record<string, unknown>;
  try {
    const resp = o["response"];
    if (resp !== null && typeof resp === "object") {
      const fromResp = getHeaderCaseInsensitive(
        (resp as Record<string, unknown>)["headers"],
        "retry-after",
      );
      if (fromResp !== null) {
        return fromResp;
      }
    }
    const fromExc = getHeaderCaseInsensitive(o["headers"], "retry-after");
    if (fromExc !== null) {
      return fromExc;
    }
    const resp3 = o["$response"];
    if (resp3 !== null && typeof resp3 === "object") {
      const fromResp3 = getHeaderCaseInsensitive(
        (resp3 as Record<string, unknown>)["headers"],
        "retry-after",
      );
      if (fromResp3 !== null) {
        return fromResp3;
      }
    }
    if (resp !== null && typeof resp === "object") {
      const meta = (resp as Record<string, unknown>)["ResponseMetadata"];
      if (meta !== null && typeof meta === "object") {
        const fromMeta = getHeaderCaseInsensitive(
          (meta as Record<string, unknown>)["HTTPHeaders"],
          "retry-after",
        );
        if (fromMeta !== null) {
          return fromMeta;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse an RFC 7231 `Retry-After` value: delta-seconds (UNSIGNED-integer syntax only —
 * `"-1"`, `"2.5"`, `"+2"`, `"1e3"`, `"inf"` are all invalid → `null`) or an HTTP-date. A
 * past HTTP-date clamps to `0.0` (never negative); a non-finite/unparseable value → `null`.
 */
function parseRetryAfterValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  // Delta-seconds: unsigned integer only.
  if (/^[0-9]+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  // A number-SHAPED token that is not an unsigned integer (signed / decimal / exponent /
  // `Infinity`) is an invalid delta — reject WITHOUT attempting an HTTP-date parse (so
  // `Date.parse("-1")` cannot accidentally succeed).
  if (/^[+-]?(?:[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|Infinity)$/.test(trimmed)) {
    return null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  const deltaSeconds = (dateMs - Date.now()) / 1000;
  return deltaSeconds > 0 ? deltaSeconds : 0.0;
}

/**
 * Non-negative seconds to wait before a same-provider retry, ONLY when the exception's
 * status inspection reads EXACTLY `429` (never 529, never any other status even with a
 * valid header) AND it carries a parseable `Retry-After`; `null` otherwise.
 */
export function retryAfterSeconds(exc: unknown): number | null {
  try {
    if (readStatus(exc) !== 429) return null;
    const header = readRetryAfterHeader(exc);
    return header === null ? null : parseRetryAfterValue(header);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch-loop constants + pure rule helpers (consumed by client.ts).
// ---------------------------------------------------------------------------

/** Floor (seconds) for one hop's dispatch timeout. */
export const MIN_HOP_TIMEOUT = 1.0;
/** Ceiling (seconds) for the budget pre-flight call. */
export const BUDGET_CHECK_TIMEOUT = 1.0;
/** Rolling latency-sample cap per provider. */
export const LATENCY_WINDOW = 50;
/** Below this many samples, `observedP50` returns `null`. */
export const LATENCY_MIN_SAMPLES = 3;

/**
 * A monotonic chain deadline stamped once per logical call from `failoverTotalTimeout`.
 * `remaining()` is in SECONDS and never negative; `expired()` is `remaining() <= 0`. The
 * clock is injectable (default web-standard `performance.now`, edge-safe — no `node:*`).
 */
export class Deadline {
  private readonly startMs: number;
  private totalMs: number;
  private deadlineMs: number;
  private readonly nowMs: () => number;

  constructor(totalTimeoutSeconds: number, now: () => number = () => performance.now()) {
    this.nowMs = now;
    this.startMs = now();
    this.totalMs = totalTimeoutSeconds * 1000;
    this.deadlineMs = this.startMs + this.totalMs;
  }

  /** Replace the whole-chain total while preserving elapsed time from the original start. */
  replaceTotal(totalTimeoutSeconds: number): void {
    this.totalMs = totalTimeoutSeconds * 1000;
    this.deadlineMs = this.startMs + this.totalMs;
  }

  /** Seconds left on the chain, clamped at `0` (never negative). */
  remaining(): number {
    const rem = (this.deadlineMs - this.nowMs()) / 1000;
    return rem > 0 ? rem : 0;
  }

  /** `true` once the chain budget is spent. */
  expired(): boolean {
    return this.remaining() <= 0;
  }
}

/**
 * The shrinking per-hop timeout (seconds): the remaining chain budget divided across the
 * not-yet-attempted candidates, floored at {@link MIN_HOP_TIMEOUT} but never exceeding what
 * remains; a spent deadline yields a tiny positive `0.001` (so the abort fires immediately
 * rather than waiting the SDK default).
 */
export function hopTimeout(deadline: Deadline, remainingCandidates: number): number {
  const remaining = deadline.remaining();
  if (remaining <= 0) {
    return 0.001;
  }
  return Math.min(
    remaining,
    Math.max(MIN_HOP_TIMEOUT, remaining / Math.max(1, remainingCandidates)),
  );
}

/**
 * The budget pre-flight timeout (seconds): capped by {@link BUDGET_CHECK_TIMEOUT} AND the
 * SAME chain deadline, but always strictly positive (`>= 0.001`) even for a tiny total.
 */
export function budgetCheckTimeout(
  deadline: Deadline,
  configuredTimeout: number = BUDGET_CHECK_TIMEOUT,
): number {
  return Math.max(0.001, Math.min(configuredTimeout, deadline.remaining()));
}

/**
 * The exact same-provider-retry margin (#19): a retry is attempted IFF
 * `retryDelay + MIN_HOP_TIMEOUT <= deadline.remaining()` (inclusive `<=` — a delay that
 * exactly consumes the remaining budget plus the 1.0s floor still qualifies).
 */
export function retryFitsWithinDeadline(retryDelaySeconds: number, deadline: Deadline): boolean {
  return retryDelaySeconds + MIN_HOP_TIMEOUT <= deadline.remaining();
}

/**
 * Disposition → breaker verdict (#22): `FAILOVER` and `POST_SEND_AMBIGUOUS` are both
 * provider-health signals (record one failure, subject to the single-count-per-call rule);
 * `FAIL_FAST` is request-shaped and NEVER a health signal.
 */
export function dispositionCountsAsBreakerFailure(disposition: Disposition): boolean {
  return disposition === Disposition.FAILOVER || disposition === Disposition.POST_SEND_AMBIGUOUS;
}

/** Idempotency modes gating cross-PROVIDER failover (not health tracking). */
export const IDEMPOTENCY_MODES = ["safe", "never", "always"] as const;
export type IdempotencyMode = (typeof IDEMPOTENCY_MODES)[number];

/**
 * Resolve the effective idempotency mode for one call (#23): an explicit per-call boolean
 * override wins over the client-level config — `true` → `"always"`, `false` → `"safe"`;
 * absent an override, the client-level `configMode` applies.
 */
export function resolveIdempotencyMode(
  perCallOverride: boolean | undefined,
  configMode: IdempotencyMode,
): IdempotencyMode {
  if (perCallOverride === true) {
    return "always";
  }
  if (perCallOverride === false) {
    return "safe";
  }
  return configMode;
}

/**
 * Whether a `POST_SEND_AMBIGUOUS` failure is allowed to CROSS providers under this mode —
 * only `"always"` asserts idempotency. Also the exact predicate gating the
 * `possiblySucceeded: true` telemetry flag (`POST_SEND_AMBIGUOUS && !allowed`).
 */
export function ambiguousFailoverAllowed(mode: IdempotencyMode): boolean {
  return mode === "always";
}

// ---------------------------------------------------------------------------
// Per-provider latency tracking (pure state; sans-I/O).
// ---------------------------------------------------------------------------

/**
 * Per-provider rolling latency window feeding {@link LatencyPolicy}. `recordLatency`
 * appends (oldest evicted past {@link LATENCY_WINDOW}); `observedP50` returns `null` below
 * {@link LATENCY_MIN_SAMPLES} samples, else the statistical median of the current window.
 * Every method is synchronous (no `await` between read and write) so interleaved async
 * callers cannot corrupt a window — the single-threaded analogue of Python's lock.
 */
export class LatencyTracker {
  private readonly windows = new Map<string, number[]>();
  private readonly windowSize: number;
  private readonly minSamples: number;

  constructor(options: { windowSize?: number; minSamples?: number } = {}) {
    this.windowSize = options.windowSize ?? LATENCY_WINDOW;
    this.minSamples = options.minSamples ?? LATENCY_MIN_SAMPLES;
  }

  recordLatency(provider: string, ms: number): void {
    let window = this.windows.get(provider);
    if (window === undefined) {
      window = [];
      this.windows.set(provider, window);
    }
    window.push(ms);
    if (window.length > this.windowSize) {
      window.shift();
    }
  }

  /** Median of the current window, or `null` if under-sampled / never recorded. */
  observedP50(provider: string): number | null {
    const window = this.windows.get(provider);
    if (window === undefined || window.length < this.minSamples) {
      return null;
    }
    const sorted = [...window].sort((a, b) => a - b);
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) {
      return sorted[mid] as number;
    }
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
}
