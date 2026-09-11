import type { Logger } from "./logging";
import { TransportHttpError } from "./transport";

const READ_ONLY_KEY_DIAGNOSTIC =
  "solwyn.configuration_error.read_only_key: the configured API key is read-only; use a full-scope project key for SDK budget enforcement and metadata reporting";

let diagnosticLogged = false;

/** Recognize the sanitized transport marker and emit its process-wide diagnostic once. */
export function isReadOnlyKeyError(error: unknown): boolean {
  return (
    error instanceof TransportHttpError && error.status === 403 && error.marker === "read_only_key"
  );
}

/** Recognize the sanitized transport marker and emit its process-wide diagnostic once. */
export function handleReadOnlyKeyError(error: unknown, logger: Logger): boolean {
  if (!isReadOnlyKeyError(error)) {
    return false;
  }
  if (!diagnosticLogged) {
    diagnosticLogged = true;
    try {
      logger.error(READ_ONLY_KEY_DIAGNOSTIC);
    } catch {
      // Diagnostics are best-effort and must never change terminal read-only handling.
    }
  }
  return true;
}

/** Module-only test hook; intentionally not re-exported from the package root. */
export function resetReadOnlyKeyDiagnosticForTest(): void {
  diagnosticLogged = false;
}
