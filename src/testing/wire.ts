import type { z } from "zod";

export interface PlaneResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

type Parsed<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly response: PlaneResponse };

const SAFE_ISSUE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_type: "Invalid value",
  invalid_format: "Invalid format",
  invalid_value: "Invalid value",
  too_big: "Value exceeds maximum",
  too_small: "Value is below minimum",
  unrecognized_keys: "Unrecognized field",
  custom: "Value failed validation",
});

function safeNumericLoc(path: readonly PropertyKey[]): number[] {
  return path.filter((part): part is number => typeof part === "number");
}

export function validationResponse(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly (string | number)[] = [],
): PlaneResponse {
  return {
    status: 422,
    body: {
      detail: issues.map((issue) => ({
        type: issue.code,
        loc: ["body", ...safeNumericLoc(prefix), ...safeNumericLoc(issue.path)],
        msg: SAFE_ISSUE_MESSAGES[issue.code] ?? "Invalid value",
      })),
    },
    headers: {},
  };
}

export function jsonValidationResponse(): PlaneResponse {
  return {
    status: 422,
    body: {
      detail: [{ type: "json_invalid", loc: ["body"], msg: "JSON decode error" }],
    },
    headers: {},
  };
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): Parsed<T> {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, response: validationResponse(parsed.error.issues) };
}

export function parseBodyList<T>(schema: z.ZodType<T>, body: unknown): Parsed<T[]> {
  if (!Array.isArray(body)) {
    return {
      success: false,
      response: {
        status: 422,
        body: {
          detail: [{ type: "invalid_type", loc: ["body"], msg: "Invalid value" }],
        },
        headers: {},
      },
    };
  }

  const parsed: T[] = [];
  for (let index = 0; index < body.length; index++) {
    const item = schema.safeParse(body[index]);
    if (!item.success) {
      return { success: false, response: validationResponse(item.error.issues, [index]) };
    }
    parsed.push(item.data);
  }
  return { success: true, data: parsed };
}

export function validatedResponse<T>(
  status: number,
  schema: z.ZodType<T>,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): PlaneResponse {
  return { status, body: schema.parse(body), headers };
}

export function responseToFetch(response: PlaneResponse): Response {
  const headers = new Headers(response.headers);
  const hasBody = response.body !== null && response.body !== undefined;
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(hasBody ? JSON.stringify(response.body) : null, {
    status: response.status,
    headers,
  });
}
