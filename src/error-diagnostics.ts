import { ZodError, ZodRealError } from "zod";
import { transportErrorLabel } from "./transport";

// Zod's parse helpers use an Error-derived instance with a separate prototype
// from both exported constructors. Derive it only from our own empty trusted
// instance; Zod's custom instanceof implementation reads caller-owned branding.
const zodParseErrorPrototype: object = Object.getPrototypeOf(new ZodRealError([]));

const knownPrototypes = new Map<object, string>([
  [TypeError.prototype, "TypeError"],
  [SyntaxError.prototype, "SyntaxError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [URIError.prototype, "URIError"],
  [EvalError.prototype, "EvalError"],
  [AggregateError.prototype, "AggregateError"],
  [ZodError.prototype, "ZodError"],
  [zodParseErrorPrototype, "ZodError"],
  [Error.prototype, "Error"],
]);

/**
 * Fixed diagnostic labels only. Custom class names and mutable name/constructor
 * fields are untrusted. Prototype inspection is bounded and contained; failure
 * never replaces the original budget outcome or contract-helper phase.
 * This is a diagnostic projection, never an authority/error-disposition check.
 */
export function safeExceptionType(error: unknown): string {
  const transportLabel = transportErrorLabel(error);
  if (transportLabel !== null) return transportLabel;
  if (error === null) return "null";
  if (typeof error !== "object" && typeof error !== "function") return typeof error;
  try {
    let prototype: object | null = error;
    for (let depth = 0; prototype !== null && depth < 32; depth++) {
      prototype = Object.getPrototypeOf(prototype) as object | null;
      if (prototype === null) break;
      const label = knownPrototypes.get(prototype);
      if (label !== undefined) return label;
    }
  } catch {
    // The secondary reflection failure is just as untrusted as the original value.
  }
  return "UnknownError";
}
