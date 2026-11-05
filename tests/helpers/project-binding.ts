import { ProjectBinding } from "../../src/project";
import type { FetchLike } from "../../src/transport";
import type { AuthKeyResponse } from "../../src/types";

export const TEST_API_URL = "https://api.solwyn.test";
export const TEST_API_KEY = `solwyn_sk_${"a".repeat(64)}`;
export const TEST_PROJECT = "test-project";
export const TEST_PROJECT_ID = `proj_${"0".repeat(24)}`;

/** A full-scope `GET /api/v1/auth/key` body for the test project. */
export function authKeyBody(overrides: Partial<AuthKeyResponse> = {}): AuthKeyResponse {
  return {
    account_id: "00000000-0000-4000-8000-000000000001",
    key_id: "00000000-0000-4000-8000-000000000002",
    key_prefix: TEST_API_KEY.slice(0, 26),
    key_name: "test-key",
    scope: "full",
    created_via: "dashboard",
    expires_at: "2099-01-01T00:00:00Z",
    rotation_grace_until: null,
    project_id: TEST_PROJECT_ID,
    project_name: TEST_PROJECT,
    budget_mode: "alert_only",
    ...overrides,
  };
}

export function authKeyResponse(overrides: Partial<AuthKeyResponse> = {}): Response {
  return new Response(JSON.stringify(authKeyBody(overrides)), { status: 200 });
}

/** A 401 with a JSON `detail`, as core sends for key refusals. */
export function unauthorized(detail: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ detail }), {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
  });
}

export function expired(posture: "hard_deny" | "alert_only" | null): Response {
  return unauthorized({
    code: "api_key_expired",
    message:
      "This API key expired on 2026-11-01. Rotate it in the dashboard or with solwyn keys rotate.",
    expired_at: "2026-11-01T00:00:00Z",
    api_key_id: "00000000-0000-4000-8000-000000000002",
    project_budget_mode: posture,
  });
}

/** A binding whose own `/auth/key` requests are answered by `fetch` (default: a 200). */
export function testBinding(
  options: { projectId?: string; fetch?: FetchLike; now?: () => number } = {},
): ProjectBinding {
  const projectId = options.projectId ?? TEST_PROJECT_ID;
  return new ProjectBinding({
    selector: TEST_PROJECT,
    apiUrl: TEST_API_URL,
    apiKey: TEST_API_KEY,
    fetch: options.fetch ?? (async () => authKeyResponse({ project_id: projectId })),
    timeoutMs: 1000,
    now: options.now,
  });
}

/** A binding already pinned to `projectId` through a successful `/auth/key`. */
export async function pinnedBinding(projectId = TEST_PROJECT_ID): Promise<ProjectBinding> {
  const binding = testBinding({ projectId });
  await binding.validate();
  return binding;
}

/** Auth headers for a request sent straight to a FakeControlPlane's fetch. */
export function planeHeaders(plane: {
  readonly apiKey: string;
  readonly project: string;
}): Record<string, string> {
  return { Authorization: `Bearer ${plane.apiKey}`, "Solwyn-Project": plane.project };
}
