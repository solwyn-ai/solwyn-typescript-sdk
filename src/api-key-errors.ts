/**
 * Classify Solwyn API refusals of the API key or its project.
 *
 * Status first, body second. Every 401 from the Solwyn API is a refusal, whatever the body:
 * a recognised `api_key_expired` / `api_key_invalid` code keeps its project posture, and
 * anything else (invalid JSON, an empty body, a string `detail`, no code, an unknown code)
 * becomes `api_key_invalid` with posture `unknown`, which always blocks. 400/403/404 classify
 * only on a recognised project or scope code; without one they are not refusals.
 *
 * Only allowlisted facts leave this module: the code, the posture, and the expiry date. No
 * response body text is retained or logged.
 */

/** Every refusal code the SDK acts on. */
export const REFUSAL_CODES = [
  "api_key_invalid",
  "api_key_expired",
  "project_selector_required",
  "project_selector_conflict",
  "project_not_found",
  "key_not_dedicated",
  "read_only_key",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Does the refused project promise to block anything? `unknown` always blocks. */
export type RefusalPosture = "hard_deny" | "alert_only" | "unknown";

/** A classified refusal: allowlisted, content-free facts only. */
export interface Refusal {
  readonly code: RefusalCode;
  readonly posture: RefusalPosture;
  /** `YYYY-MM-DD` from `expired_at`, only for `api_key_expired`. */
  readonly expiredOn: string | null;
}

/** Codes a 400/403/404 may carry that make it a refusal. */
const PROJECT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "project_selector_required",
  "project_selector_conflict",
  "project_not_found",
  "key_not_dedicated",
  "read_only_key",
]);

/** The statuses whose body the transport reads for classification. */
export function isClassifiedStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

function detailOf(text: string | null): Record<string, unknown> | null {
  if (text === null || text === "") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const detail = (payload as Record<string, unknown>)["detail"];
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  return detail as Record<string, unknown>;
}

function postureOf(value: unknown): RefusalPosture {
  return value === "hard_deny" || value === "alert_only" ? value : "unknown";
}

function expiredOnOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Classify a Solwyn API response. `text` is the response body, or `null` when it could not be
 * read. Returns `undefined` when the response is not a refusal.
 */
export function classify(status: number, text: string | null): Refusal | undefined {
  const detail = detailOf(text);
  const code = detail?.["code"];
  if (status === 401) {
    if (code === "api_key_expired") {
      return Object.freeze({
        code: "api_key_expired",
        posture: postureOf(detail?.["project_budget_mode"]),
        expiredOn: expiredOnOf(detail?.["expired_at"]),
      });
    }
    if (code === "api_key_invalid") {
      return Object.freeze({
        code: "api_key_invalid",
        posture: postureOf(detail?.["project_budget_mode"]),
        expiredOn: null,
      });
    }
    return Object.freeze({ code: "api_key_invalid", posture: "unknown", expiredOn: null });
  }
  if (
    (status === 400 || status === 403 || status === 404) &&
    typeof code === "string" &&
    PROJECT_REFUSAL_CODES.has(code)
  ) {
    return Object.freeze({ code: code as RefusalCode, posture: "unknown", expiredOn: null });
  }
  return undefined;
}

const READ_ONLY_MESSAGE =
  "This Solwyn API key is read-only. The SDK reports spending, so it needs a full-scope key. Create one in the dashboard or with solwyn keys create.";

/** The exact user-facing message and field for a refusal. */
export function refusalMessage(
  refusal: Refusal,
  selector: string,
): { message: string; field: "api_key" | "project" } {
  switch (refusal.code) {
    case "api_key_expired":
      return {
        message:
          refusal.expiredOn === null
            ? "The Solwyn API key has expired. Rotate it in the dashboard or with solwyn keys rotate."
            : `The Solwyn API key expired on ${refusal.expiredOn}. Rotate it in the dashboard or with solwyn keys rotate.`,
        field: "api_key",
      };
    case "api_key_invalid":
      return {
        message: "The Solwyn API key was not recognised or has been revoked.",
        field: "api_key",
      };
    case "read_only_key":
      return { message: READ_ONLY_MESSAGE, field: "api_key" };
    case "project_not_found":
      return {
        message: `Solwyn project '${selector}' was not found for this API key. Check SOLWYN_PROJECT. A renamed project's old name stops working; its proj_ id always works.`,
        field: "project",
      };
    case "key_not_dedicated":
      return {
        message: `Solwyn project '${selector}' only accepts API keys dedicated to it, and this key also reaches other projects. Use a key that holds only this project.`,
        field: "project",
      };
    case "project_selector_required":
    case "project_selector_conflict":
      return {
        message: `Solwyn refused the project header (${refusal.code}). This is an SDK bug; please report it.`,
        field: "project",
      };
  }
}
