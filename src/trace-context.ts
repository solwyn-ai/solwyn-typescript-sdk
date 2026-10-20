/**
 * Optional OpenTelemetry trace correlation, read without importing OpenTelemetry.
 *
 * Every `@opentelemetry/api` 1.x copy shares one process-global registry at
 * `Symbol.for("opentelemetry.js.api.1")`; an application's registered context manager
 * lives in its `context` slot, and the active span sits in the active context under the
 * registered `Symbol.for("OpenTelemetry Context Key SPAN")` key. This module reads that
 * registry structurally, so the SDK has no OpenTelemetry dependency (not even an optional
 * peer), nothing is resolved or loaded, and a process without OpenTelemetry pays one
 * global lookup. Both `globalThis` and `Symbol.for` are web-standard, so this stays
 * edge-safe, and duplicate ESM/CJS copies of the API resolve to the same registry.
 *
 * Privacy contract (pinned by `tests/unit/otel-privacy-firewall.test.ts`): only a span's
 * `spanContext()` is read, and only its trace id, span id, and trace flags leave this
 * module, as fixed-width lowercase hex strings and a boolean. Span attributes, events,
 * names, status, trace state, and baggage values are never read. Nothing is injected,
 * propagated, or recorded, and no span is created. Every failure resolves to "no trace":
 * telemetry enrichment never interrupts a call or invalidates a spend event.
 */

import {
  SPAN_ID_HEX_LENGTH,
  SPAN_ID_PATTERN,
  TRACE_ID_HEX_LENGTH,
  TRACE_ID_PATTERN,
} from "./types";

/** Immutable trace identifiers captured once at call start and closed over thereafter. */
export interface TraceSnapshot {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

/** The registry slot shared by every `@opentelemetry/api` 1.x copy in the process. */
const OTEL_API_REGISTRY_KEY = Symbol.for("opentelemetry.js.api.1");
/** The context key under which the API stores the active span. */
const SPAN_CONTEXT_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
/** The context key under which the API stores baggage; only ever removed, never read. */
const BAGGAGE_CONTEXT_KEY = Symbol.for("OpenTelemetry Baggage Key");

const INVALID_TRACE_ID = "0".repeat(TRACE_ID_HEX_LENGTH);
const INVALID_SPAN_ID = "0".repeat(SPAN_ID_HEX_LENGTH);
/** W3C `sampled` bit of the trace flags. */
const SAMPLED_FLAG = 0x01;

/** Structural view of an OpenTelemetry context manager (`context` registry slot). */
interface ContextManagerShape {
  active(): unknown;
  with(context: unknown, fn: () => unknown): unknown;
}

/** The registered context manager, or `undefined` when none is registered (the idle path). */
function registeredContextManager(): ContextManagerShape | undefined {
  const registry = (globalThis as Record<symbol, unknown>)[OTEL_API_REGISTRY_KEY];
  if (registry === undefined || registry === null || typeof registry !== "object") {
    return undefined;
  }
  const version = (registry as { version?: unknown }).version;
  if (typeof version !== "string" || !version.startsWith("1.")) return undefined;
  const manager = (registry as { context?: unknown }).context;
  if (manager === undefined || manager === null || typeof manager !== "object") return undefined;
  if (typeof (manager as { active?: unknown }).active !== "function") return undefined;
  return manager as ContextManagerShape;
}

/** Read one value from an OpenTelemetry context, or `undefined` for a non-context. */
function contextValue(context: unknown, key: symbol): unknown {
  if (context === undefined || context === null || typeof context !== "object") return undefined;
  const getValue = (context as { getValue?: unknown }).getValue;
  if (typeof getValue !== "function") return undefined;
  return Reflect.apply(getValue, context, [key]);
}

/**
 * Normalize untrusted identifiers into a frozen snapshot, or `undefined` when any part is
 * malformed. Ids must be fixed-width hex (case-insensitive on input, lowercase on output)
 * and not the all-zero invalid id; `sampled` must be a real boolean. Also applied again
 * at the event builders so a malformed value can never invalidate a spend event.
 */
export function validatedTrace(trace: unknown): TraceSnapshot | undefined {
  if (trace === undefined || trace === null || typeof trace !== "object") return undefined;
  try {
    const { traceId, spanId, sampled } = trace as Record<string, unknown>;
    if (typeof traceId !== "string" || typeof spanId !== "string" || typeof sampled !== "boolean") {
      return undefined;
    }
    const normalizedTraceId = traceId.toLowerCase();
    const normalizedSpanId = spanId.toLowerCase();
    if (
      !TRACE_ID_PATTERN.test(normalizedTraceId) ||
      !SPAN_ID_PATTERN.test(normalizedSpanId) ||
      normalizedTraceId === INVALID_TRACE_ID ||
      normalizedSpanId === INVALID_SPAN_ID
    ) {
      return undefined;
    }
    return Object.freeze({ traceId: normalizedTraceId, spanId: normalizedSpanId, sampled });
  } catch {
    return undefined;
  }
}

/**
 * Snapshot the caller's active span context, or `undefined` when OpenTelemetry is absent,
 * no context manager is registered, no valid span is active, or anything fails. Call this
 * synchronously on the caller's path at call start, exactly once per logical call, and
 * pass the result explicitly; never re-read it while a stream is consumed or settled.
 */
export function captureTrace(): TraceSnapshot | undefined {
  try {
    const manager = registeredContextManager();
    if (manager === undefined) return undefined;
    const span = contextValue(manager.active(), SPAN_CONTEXT_KEY);
    if (span === undefined || span === null || typeof span !== "object") return undefined;
    const spanContextMethod = (span as { spanContext?: unknown }).spanContext;
    if (typeof spanContextMethod !== "function") return undefined;
    const spanContext: unknown = Reflect.apply(spanContextMethod, span, []);
    if (spanContext === undefined || spanContext === null || typeof spanContext !== "object") {
      return undefined;
    }
    const { traceId, spanId, traceFlags } = spanContext as Record<string, unknown>;
    if (typeof traceFlags !== "number" || !Number.isInteger(traceFlags)) return undefined;
    return validatedTrace({
      traceId,
      spanId,
      sampled: (traceFlags & SAMPLED_FLAG) === SAMPLED_FLAG,
    });
  } catch {
    // Optional enrichment never interrupts a call, including for a custom span or
    // context manager that throws.
    return undefined;
  }
}

/**
 * Run `fn` with the caller's active span and baggage removed from the OpenTelemetry
 * context, so background work it starts (timers, promise chains, control-plane requests)
 * is not attributed to the trace of whichever call happened to launch it, and does not
 * retain that call's span. Other context values are left untouched. Without a registered
 * context manager, or when the active context holds neither value, `fn` runs directly.
 */
export function withoutTraceContext<T>(fn: () => T): T {
  let manager: ContextManagerShape | undefined;
  let detached: unknown;
  try {
    manager = registeredContextManager();
    if (manager !== undefined && typeof manager.with === "function") {
      const active = manager.active();
      if (
        contextValue(active, SPAN_CONTEXT_KEY) !== undefined ||
        contextValue(active, BAGGAGE_CONTEXT_KEY) !== undefined
      ) {
        detached = deleteContextValue(
          deleteContextValue(active, SPAN_CONTEXT_KEY),
          BAGGAGE_CONTEXT_KEY,
        );
        // A context that cannot drop the span must not be entered at all.
        if (contextValue(detached, SPAN_CONTEXT_KEY) !== undefined) detached = undefined;
      }
    }
  } catch {
    detached = undefined;
  }
  if (manager === undefined || detached === undefined) return fn();
  let entered = false;
  try {
    return manager.with(detached, () => {
      entered = true;
      return fn();
    }) as T;
  } catch (error) {
    // A failure raised by `fn` itself propagates unchanged; only a context manager that
    // failed before entering falls back to running `fn` in the current context.
    if (entered) throw error;
    return fn();
  }
}

/** A copy of `context` without `key`, or `undefined` for anything that is not a context. */
function deleteContextValue(context: unknown, key: symbol): unknown {
  if (context === undefined || context === null || typeof context !== "object") return undefined;
  const deleteValue = (context as { deleteValue?: unknown }).deleteValue;
  if (typeof deleteValue !== "function") return undefined;
  const next: unknown = Reflect.apply(deleteValue, context, [key]);
  return next !== null && typeof next === "object" ? next : undefined;
}

/** Stamp a call-start snapshot onto a metadata event, omitting every field when absent. */
export function applyTraceFields(
  event: { trace_id?: string | null; span_id?: string | null; trace_sampled?: boolean | null },
  trace: unknown,
): void {
  const snapshot = validatedTrace(trace);
  if (snapshot === undefined) return;
  event.trace_id = snapshot.traceId;
  event.span_id = snapshot.spanId;
  event.trace_sampled = snapshot.sampled;
}
