/**
 * API key scoping: the project binding, the entry gate and the exit check.
 *
 * Fixtures F1 to F18 (F6 and F6b live in api-key-errors.test.ts). Each fixture is one named
 * test. Wrapped-client fixtures run against the FakeControlPlane; race fixtures drive a
 * BudgetEnforcer with a scripted fetch so the order of responses is exact.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { ApiKeyRefusedError, ConfigurationError } from "../../src/errors";
import type { Logger } from "../../src/logging";
import { ProjectBinding } from "../../src/project";
import { MetadataReporter } from "../../src/reporter";
import { FakeControlPlane } from "../../src/testing/index";
import { zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";
import {
  authKeyResponse,
  expired,
  TEST_API_KEY,
  TEST_API_URL,
  TEST_PROJECT,
  TEST_PROJECT_ID,
  unauthorized,
} from "../helpers/project-binding";

const AUTH_KEY_PATH = "/api/v1/auth/key";
const CHECK_PATH = "/api/v1/budgets/check";
const CONFIRM_PATH = "/api/v1/budgets/confirm";
const INGEST_PATH = "/api/v1/metadata/ingest";
const EXPIRED_MESSAGE =
  "The Solwyn API key expired on 2026-11-01. Rotate it in the dashboard or with solwyn keys rotate.";
const READ_ONLY_MESSAGE =
  "This Solwyn API key is read-only. The SDK reports spending, so it needs a full-scope key. Create one in the dashboard or with solwyn keys create.";

interface Captured extends Logger {
  readonly errors: string[];
}

function capture(): Captured {
  const errors: string[] = [];
  return {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string) => {
      errors.push(message);
    },
  };
}

function provider() {
  const create = vi.fn((_kwargs: Record<string, unknown>) => ({
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  }));
  return { client: { chat: { completions: { create } } }, create };
}

function allowBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    allowed: true,
    remaining_budget: 90,
    reservation_id: null,
    mode: "hard_deny",
    budget_limit: 100,
    current_usage: 10,
    denied_by_period: null,
    project_id: TEST_PROJECT_ID,
    price_hints: null,
    ...overrides,
  });
}

function allow(): Response {
  return new Response(allowBody(), { status: 200 });
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function checkOptions(overrides: Record<string, unknown> = {}) {
  return {
    estimatedInputTokens: 10,
    model: "gpt-4o",
    provider: "openai" as const,
    ...overrides,
  };
}

/**
 * A fetch whose answers are queued per path; an empty queue falls back to `fallback`. `setKey`
 * models the key's server-side state: once set, `/auth/key` answers with it (as a real server
 * would after refusing the key on the data plane), unless an answer is queued.
 */
function scripted(fallback: (path: string) => Response | Promise<Response>) {
  const queues = new Map<string, Array<() => Response | Promise<Response>>>();
  const headers: Array<{ path: string; project: string | null }> = [];
  let key: (() => Response | Promise<Response>) | null = null;
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const path = pathOf(url);
    headers.push({ path, project: new Headers(init?.headers).get("Solwyn-Project") });
    const next = queues.get(path)?.shift();
    if (next !== undefined) return next();
    if (path === AUTH_KEY_PATH && key !== null) return key();
    return fallback(path);
  });
  return {
    fetch,
    headers,
    queue(path: string, ...answers: Array<() => Response | Promise<Response>>) {
      queues.set(path, [...(queues.get(path) ?? []), ...answers]);
    },
    setKey(answer: (() => Response | Promise<Response>) | null) {
      key = answer;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function enforcer(
  fetch: FetchLike,
  options: { now?: () => number; logger?: Logger; failOpen?: boolean; cacheTtl?: number } = {},
) {
  return new BudgetEnforcer({
    apiUrl: TEST_API_URL,
    apiKey: TEST_API_KEY,
    project: TEST_PROJECT,
    fetch,
    monotonicNow: options.now,
    logger: options.logger,
    failOpen: options.failOpen ?? true,
    cacheTtl: options.cacheTtl ?? 0,
    leaseEnabled: false,
  });
}

async function refusalOf(promise: Promise<unknown>): Promise<ApiKeyRefusedError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiKeyRefusedError);
  expect(error).toBeInstanceOf(ConfigurationError);
  return error as ApiKeyRefusedError;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

function wrap(plane: FakeControlPlane, logger?: Logger, options: Record<string, unknown> = {}) {
  const upstream = provider();
  const wrapped = plane.wrap(upstream.client, {
    leaseEnabled: false,
    reportUntrackedSurfaces: false,
    ...(logger === undefined ? {} : { logger }),
    ...options,
  });
  closers.push(() => wrapped.close());
  return { wrapped, create: upstream.create };
}

describe("F1 to F18: refusals never run a provider call unmetered by accident", () => {
  it("F1: validate() with a read_only key raises the read-only ConfigurationError, no provider call", async () => {
    const plane = new FakeControlPlane({ keyScope: "read_only" });
    const { wrapped, create } = wrap(plane);
    const error = await refusalOf(wrapped.validate());
    expect(error.message).toBe(READ_ONLY_MESSAGE);
    expect(error.code).toBe("read_only_key");
    expect(error.field).toBe("api_key");
    await refusalOf(wrapped.chat.completions.create({ model: "gpt-4o" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("F2: runtime 403 read_only_key on a check with failOpen blocks, and the next call blocks without network", async () => {
    const plane = new FakeControlPlane({ mode: "hard_deny" });
    const { wrapped, create } = wrap(plane, undefined, { failOpen: true });
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    expect(create).toHaveBeenCalledTimes(1);

    plane.readOnly({ path: CHECK_PATH });
    const error = await refusalOf(wrapped.chat.completions.create({ model: "gpt-4o" }));
    expect(error.message).toBe(READ_ONLY_MESSAGE);
    const requests = plane.projectHeaders.length;
    await refusalOf(wrapped.chat.completions.create({ model: "gpt-4o" }));
    expect(plane.projectHeaders.length).toBe(requests);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("F3: alert_only at validation, then hard_deny and an expired key: the 401 says hard_deny, blocked", async () => {
    const plane = new FakeControlPlane({ mode: "alert_only" });
    const { wrapped, create } = wrap(plane);
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    plane.expireKey({ projectBudgetMode: "hard_deny" });
    const error = await refusalOf(wrapped.chat.completions.create({ model: "gpt-4o" }));
    expect(error.message).toBe(EXPIRED_MESSAGE);
    expect(error.code).toBe("api_key_expired");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("F4: hard_deny project switched to alert_only, key expires, 401 says alert_only: allowed unmetered, error logged", async () => {
    const plane = new FakeControlPlane({ mode: "hard_deny" });
    const logger = capture();
    const { wrapped, create } = wrap(plane, logger);
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    plane.expireKey({ projectBudgetMode: "alert_only" });
    const checks = plane.checks.length;
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    expect(create).toHaveBeenCalledTimes(3);
    // The second call's check got the 401; the third ran with no check at all.
    expect(plane.checks.length).toBe(checks);
    expect(logger.errors.filter((line) => line.startsWith("solwyn.api_key_refused"))).toHaveLength(
      2,
    );
  });

  it("F5: alert_only project with an unpaused scoped hard_deny rule, key expires: 401 hard_deny, blocked", async () => {
    // The fake derives the refusal posture like core: the scoped rule is the hard posture.
    const plane = new FakeControlPlane({ mode: "alert_only", postureMode: "hard_deny" });
    const { wrapped, create } = wrap(plane);
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    plane.expireKey();
    await refusalOf(wrapped.chat.completions.create({ model: "gpt-4o" }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("F5b: the same scoped rule paused: 401 alert_only, allowed unmetered", async () => {
    const plane = new FakeControlPlane({ mode: "alert_only", postureMode: "alert_only" });
    const { wrapped, create } = wrap(plane);
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    plane.expireKey();
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unsnoozed", "hard_deny"],
    ["snoozed", "hard_deny"],
  ] as const)("F5c: alert_only project with a hard run cap (%s), key expires: 401 hard_deny, blocked", async (_label, posture) => {
    const plane = new FakeControlPlane({ mode: "alert_only", postureMode: posture });
    const { wrapped, create } = wrap(plane);
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    plane.expireKey();
    await refusalOf(wrapped.chat.completions.create({ model: "gpt-4o" }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["paused", "alert_only"],
    ["mode alert_only", "alert_only"],
  ] as const)("F5d: the run cap %s: 401 alert_only, allowed unmetered", async (_label, posture) => {
    const plane = new FakeControlPlane({ mode: "alert_only", postureMode: posture });
    const { wrapped, create } = wrap(plane);
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    plane.expireKey();
    await wrapped.chat.completions.create({ model: "gpt-4o" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("F7: refused (block), then revalidation and checks time out or 5xx: still blocked", async () => {
    let now = 0;
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch, { now: () => now });
    await budget.checkBudget(checkOptions());
    plane.setKey(() => expired("hard_deny"));
    plane.queue(CHECK_PATH, () => expired("hard_deny"));
    await refusalOf(budget.checkBudget(checkOptions()));

    now += 60_000;
    plane.queue(AUTH_KEY_PATH, () => new Response("busy", { status: 503 }));
    await refusalOf(budget.checkBudget(checkOptions()));
    now += 60_000;
    plane.queue(AUTH_KEY_PATH, () => Promise.reject(new TypeError("fetch failed")));
    await refusalOf(budget.checkBudget(checkOptions()));
    expect(budget.binding.state).toBe("refused");
    // No check request was sent while refused: the gate stops before the outage ladder.
    expect(plane.headers.filter((entry) => entry.path === CHECK_PATH)).toHaveLength(2);
  });

  it("F7b: refused allow_unmetered after validating: a brief block until the prompt revalidation relaxes it, then every 60 s revalidation keeps returning the 401; nothing throws", async () => {
    let now = 0;
    const logger = capture();
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch, { now: () => now, logger });
    await budget.checkBudget(checkOptions());
    plane.setKey(() => expired("alert_only"));
    const prompt = deferred<Response>();
    plane.queue(AUTH_KEY_PATH, () => prompt.promise);
    plane.queue(CHECK_PATH, () => expired("alert_only"));

    // The 401's status blocks at once; its own alert_only body cannot relax that block.
    await refusalOf(budget.checkBudget(checkOptions()));
    expect(budget.binding.refusal).toMatchObject({ effect: "block" });
    await refusalOf(budget.checkBudget(checkOptions()));

    // The revalidation started at the 401 (dispatched after the block) relaxes it promptly.
    prompt.resolve(expired("alert_only"));
    await vi.waitFor(() =>
      expect(budget.binding.refusal).toMatchObject({ effect: "allow_unmetered" }),
    );
    expect(now).toBe(0);
    await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({
      allowed: true,
      reservationId: null,
    });
    for (let round = 0; round < 3; round++) {
      now += 60_000;
      await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({ allowed: true });
    }
    expect(plane.headers.filter((entry) => entry.path === AUTH_KEY_PATH)).toHaveLength(5);
    expect(plane.headers.filter((entry) => entry.path === CHECK_PATH)).toHaveLength(2);
    expect(budget.binding.refusal).toMatchObject({ effect: "allow_unmetered" });
  });

  it("F8: refused while a lease is held, and while a cached allow is live: blocked", async () => {
    // alert_only so the per-call allow is cacheable; the refusal itself says hard_deny.
    const plane = new FakeControlPlane({ mode: "alert_only" });
    const binding = new ProjectBinding({
      selector: plane.project,
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      timeoutMs: 1000,
    });
    const leased = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      binding,
      fetch: plane.fetch,
      leaseEnabled: true,
    });
    const cached = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      binding,
      fetch: plane.fetch,
      cacheTtl: 60,
      leaseEnabled: false,
    });
    const reporter = new MetadataReporter(plane.apiUrl, plane.apiKey, {
      binding,
      fetch: plane.fetch,
    });
    closers.push(
      () => leased.close(),
      () => cached.close(),
      () => reporter.close(0),
    );
    const leasedCall = () =>
      leased.checkBudget(checkOptions({ agentRunId: "run-f8", estimatedOutputBound: 10 }));
    expect((await leasedCall()).leaseId).not.toBeNull();
    expect((await leasedCall()).leaseId).not.toBeNull();
    expect(plane.leaseGrants).toHaveLength(1);
    expect((await cached.checkBudget(checkOptions())).allowed).toBe(true);
    const checks = plane.checks.length;
    expect((await cached.checkBudget(checkOptions())).allowed).toBe(true);
    expect(plane.checks.length).toBe(checks);

    // A background confirm learns the key expired.
    plane.expireKey({ projectBudgetMode: "hard_deny" });
    reporter.reportConfirm(
      BudgetConfirmRequestSchema.parse({
        reservation_id: "r-f8",
        model: "gpt-4o",
        provider: "openai",
        call_id: "00000000-0000-4000-8000-0000000000f8",
        token_details: zeroTokenDetails(),
      }),
    );
    await reporter._flushRemaining();
    expect(binding.state).toBe("refused");

    await refusalOf(leasedCall());
    await refusalOf(cached.checkBudget(checkOptions()));
    expect(plane.checks.length).toBe(checks);
  });

  it("F9: refused with the control-plane breaker open: blocked, never the outage posture", async () => {
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 3600,
      successThreshold: 1,
      name: "control-plane",
    });
    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
      fetch: plane.fetch,
      controlPlaneBreaker: breaker,
      cacheTtl: 0,
      leaseEnabled: false,
    });
    await budget.checkBudget(checkOptions());
    plane.setKey(() => expired("hard_deny"));
    plane.queue(CHECK_PATH, () => expired("hard_deny"));
    await refusalOf(budget.checkBudget(checkOptions()));
    breaker.recordFailure();
    expect(breaker.getState().state).toBe("open");
    await refusalOf(budget.checkBudget(checkOptions()));
  });

  it("F10: refused, then revalidation returns 200 full: calls proceed with the pinned id in the header", async () => {
    let now = 0;
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch, { now: () => now });
    await budget.checkBudget(checkOptions());
    plane.setKey(() => expired("hard_deny"));
    plane.queue(CHECK_PATH, () => expired("hard_deny"));
    await refusalOf(budget.checkBudget(checkOptions()));
    await refusalOf(budget.checkBudget(checkOptions()));
    // The key is rotated server-side; the next revalidation succeeds.
    plane.setKey(null);
    now += 60_000;
    await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({ allowed: true });
    expect(budget.binding.state).toBe("valid");
    expect(plane.headers.at(-1)).toEqual({ path: CHECK_PATH, project: TEST_PROJECT_ID });
  });

  it("F11: project_not_found on a background confirm and ingest: dropped, not retried; the next call is blocked", async () => {
    const plane = new FakeControlPlane();
    const binding = new ProjectBinding({
      selector: plane.project,
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      timeoutMs: 1000,
    });
    const budget = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      binding,
      fetch: plane.fetch,
      cacheTtl: 0,
      leaseEnabled: false,
    });
    const reporter = new MetadataReporter(plane.apiUrl, plane.apiKey, {
      binding,
      fetch: plane.fetch,
    });
    closers.push(
      () => budget.close(),
      () => reporter.close(0),
    );
    await budget.checkBudget(checkOptions());
    expect(binding.state).toBe("valid");

    // The project is renamed away from under a key that sent its name: nothing matches now.
    plane.refuseProject("project_not_found", { path: CONFIRM_PATH });
    plane.refuseProject("project_not_found", { path: INGEST_PATH });
    reporter.reportConfirm(
      BudgetConfirmRequestSchema.parse({
        reservation_id: "r-f11",
        model: "gpt-4o",
        provider: "openai",
        call_id: "00000000-0000-4000-8000-0000000000f1",
        token_details: zeroTokenDetails(),
      }),
    );
    reporter.report(
      MetadataEventSchema.parse({
        model: "gpt-4o",
        provider: "openai",
        input_tokens: 1,
        output_tokens: 1,
        latency_ms: 1,
        status: "success",
        is_model_fallback: false,
        call_id: "00000000-0000-4000-8000-0000000000f2",
        sdk_instance_id: "sdk-f11",
        timestamp: "2026-11-05T00:00:00Z",
      }),
    );
    await reporter._flushRemaining();
    const sent = plane.projectHeaders.length;
    expect(reporter.confirmQueueSize).toBe(0);
    await reporter._flushRemaining();
    expect(plane.projectHeaders.length).toBe(sent);
    expect(plane.confirms).toHaveLength(0);
    expect(plane.ingested).toHaveLength(0);
    expect(binding.refusal).toMatchObject({ code: "project_not_found", effect: "block" });
    const error = await refusalOf(budget.checkBudget(checkOptions()));
    expect(error.field).toBe("project");
  });

  it.each([
    ["200 allow", () => allow()],
    ["5xx", () => new Response("down", { status: 503 })],
    ["429", () => new Response("slow", { status: 429, headers: { "Retry-After": "1" } })],
    ["unreadable 2xx body", () => new Response("{not json", { status: 200 })],
    ["transport error", () => Promise.reject(new TypeError("fetch failed"))],
    ["timeout", () => new Promise<Response>(() => {})],
  ] as const)("F12: A's check gets a hard 401 while B's check ends in %s: B is blocked", async (_label, answerB) => {
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch, { failOpen: true });
    await budget.binding.validate();
    plane.setKey(() => expired("hard_deny"));
    const a = deferred<Response>();
    const b = deferred<Response>();
    plane.queue(
      CHECK_PATH,
      () => a.promise,
      () => b.promise,
    );
    const callA = budget.checkBudget(checkOptions());
    const callB = budget.checkBudget(checkOptions({ timeout: 0.2 }));
    await vi.waitFor(() => expect(plane.fetch).toHaveBeenCalledTimes(3));
    a.resolve(expired("hard_deny"));
    await refusalOf(callA);
    Promise.resolve(answerB()).then(b.resolve, b.reject);
    await refusalOf(callB);
  });

  it("F13: the first call's automatic validation gets 401 api_key_expired alert_only: blocked, and every later call until a 200", async () => {
    let now = 0;
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? expired("alert_only") : allow()));
    const budget = enforcer(plane.fetch, { now: () => now });
    const error = await refusalOf(budget.checkBudget(checkOptions()));
    expect(error.message).toBe(EXPIRED_MESSAGE);
    await refusalOf(budget.checkBudget(checkOptions()));
    now += 60_000;
    await refusalOf(budget.checkBudget(checkOptions()));
    expect(plane.headers.filter((entry) => entry.path === CHECK_PATH)).toHaveLength(0);
    plane.queue(AUTH_KEY_PATH, () => authKeyResponse());
    now += 60_000;
    await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({ allowed: true });
  });

  it("F14: startup outage fails open with the selector header; after 30 s the pin takes over and survives a rename", async () => {
    let now = 0;
    const plane = new FakeControlPlane({ mode: "alert_only" });
    const budget = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      project: plane.project,
      fetch: plane.fetch,
      monotonicNow: () => now,
      cacheTtl: 0,
      leaseEnabled: false,
    });
    closers.push(() => budget.close());
    const outage = plane.outage({ path: AUTH_KEY_PATH });
    await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({ allowed: true });
    expect(plane.projectHeaders.at(-1)).toBe("test-project");
    expect(budget.binding.state).toBe("unvalidated");
    now += 10_000;
    await budget.checkBudget(checkOptions());
    expect(plane.authKeyRequests).toHaveLength(0);

    outage.end();
    now += 30_000;
    await budget.checkBudget(checkOptions());
    expect(budget.binding.state).toBe("valid");
    expect(plane.projectHeaders.at(-1)).toBe(`proj_${"0".repeat(24)}`);

    plane.renameProject("renamed-project");
    await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({ allowed: true });
    expect(plane.projectHeaders.at(-1)).toBe(`proj_${"0".repeat(24)}`);
  });

  it("F15: unvalidated after an outage, a check returns 404 project_not_found: refused and blocked", async () => {
    const plane = new FakeControlPlane();
    const budget = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      project: plane.project,
      fetch: plane.fetch,
      cacheTtl: 0,
      leaseEnabled: false,
    });
    closers.push(() => budget.close());
    plane.outage({ path: AUTH_KEY_PATH, requests: 1 });
    plane.refuseProject("project_not_found", { path: CHECK_PATH, requests: 1 });
    const error = await refusalOf(budget.checkBudget(checkOptions()));
    expect(error.message).toBe(
      "Solwyn project 'test-project' was not found for this API key. Check SOLWYN_PROJECT. A renamed project's old name stops working; its proj_ id always works.",
    );
    expect(error.field).toBe("project");
    await refusalOf(budget.checkBudget(checkOptions()));
  });

  it("F16: B's hard 401 is recorded first, A's delayed alert_only 401 (same dispatch generation) cannot relax it", async () => {
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch);
    await budget.binding.validate();
    plane.setKey(() => expired("hard_deny"));
    const a = deferred<Response>();
    const b = deferred<Response>();
    plane.queue(
      CHECK_PATH,
      () => a.promise,
      () => b.promise,
    );
    const callA = budget.checkBudget(checkOptions());
    const callB = budget.checkBudget(checkOptions());
    await vi.waitFor(() => expect(plane.fetch).toHaveBeenCalledTimes(3));
    b.resolve(expired("hard_deny"));
    await refusalOf(callB);
    a.resolve(expired("alert_only"));
    await refusalOf(callA);
    await vi.waitFor(() =>
      expect(budget.binding.refusal).toMatchObject({ effect: "block", posture: "hard_deny" }),
    );
    await refusalOf(budget.checkBudget(checkOptions()));
  });

  it("F17: a /auth/key 200 dispatched with check C, arriving after C's blocking 401, is ignored", async () => {
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch);
    await budget.binding.validate();
    plane.setKey(() => expired("hard_deny"));
    const auth = deferred<Response>();
    const c = deferred<Response>();
    plane.queue(AUTH_KEY_PATH, () => auth.promise);
    plane.queue(CHECK_PATH, () => c.promise);
    const validation = budget.binding.validate();
    const callC = budget.checkBudget(checkOptions());
    await vi.waitFor(() => expect(plane.fetch).toHaveBeenCalledTimes(3));
    c.resolve(expired("hard_deny"));
    await refusalOf(callC);
    auth.resolve(authKeyResponse());
    await refusalOf(validation);
    expect(budget.binding.state).toBe("refused");
    await refusalOf(budget.checkBudget(checkOptions()));
  });

  it("F18: refused block; the next gate revalidation (sent after the refusal) gets 401 alert_only and relaxes to allow_unmetered", async () => {
    let now = 0;
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch, { now: () => now });
    await budget.checkBudget(checkOptions());
    plane.setKey(() => expired("hard_deny"));
    plane.queue(CHECK_PATH, () => expired("hard_deny"));
    await refusalOf(budget.checkBudget(checkOptions()));
    await vi.waitFor(() => expect(budget.binding.refusal?.posture).toBe("hard_deny"));
    // The owner pauses the hard rule; the next 60 s revalidation sees alert_only.
    plane.setKey(() => expired("alert_only"));
    now += 60_000;
    await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({
      allowed: true,
      reservationId: null,
    });
    expect(budget.binding.refusal).toMatchObject({ effect: "allow_unmetered" });
  });
});

describe("exit check rerun", () => {
  it("re-runs a check once, with the pinned id, when a concurrent revalidation succeeds while it is in flight", async () => {
    let now = 0;
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch, { now: () => now });
    const first = deferred<Response>();
    plane.queue(AUTH_KEY_PATH, () => Promise.reject(new TypeError("fetch failed")));
    plane.queue(CHECK_PATH, () => first.promise);
    // A long budget so the injected clock's 30 s jump leaves the re-run inside its deadline.
    const callA = budget.checkBudget(checkOptions({ timeout: 120 }));
    await vi.waitFor(() => expect(plane.fetch).toHaveBeenCalledTimes(2));
    expect(plane.headers[1]).toEqual({ path: CHECK_PATH, project: TEST_PROJECT });

    now += 30_000;
    await expect(budget.checkBudget(checkOptions())).resolves.toMatchObject({ allowed: true });
    expect(budget.binding.state).toBe("valid");
    first.resolve(allow());
    await expect(callA).resolves.toMatchObject({ allowed: true });
    expect(plane.headers.map((entry) => entry.path)).toEqual([
      AUTH_KEY_PATH,
      CHECK_PATH,
      AUTH_KEY_PATH,
      CHECK_PATH,
      CHECK_PATH,
    ]);
    expect(plane.headers.at(-1)).toEqual({ path: CHECK_PATH, project: TEST_PROJECT_ID });
  });
});

describe("ProjectBinding fencing and validation", () => {
  it("pins only from /auth/key and sends the selector until then", async () => {
    const plane = scripted((path) => (path === AUTH_KEY_PATH ? authKeyResponse() : allow()));
    const budget = enforcer(plane.fetch);
    expect(budget.binding.headerValue).toBe(TEST_PROJECT);
    await budget.checkBudget(checkOptions());
    expect(plane.headers).toEqual([
      { path: AUTH_KEY_PATH, project: TEST_PROJECT },
      { path: CHECK_PATH, project: TEST_PROJECT_ID },
    ]);
  });

  it("a check response's project_id never pins", async () => {
    const plane = scripted((path) =>
      path === AUTH_KEY_PATH
        ? Promise.reject(new TypeError("fetch failed"))
        : new Response(allowBody({ project_id: `proj_${"f".repeat(24)}` }), { status: 200 }),
    );
    const budget = enforcer(plane.fetch);
    await budget.checkBudget(checkOptions());
    expect(budget.binding.pinnedId).toBeNull();
    expect(plane.headers.at(-1)?.project).toBe(TEST_PROJECT);
  });

  it("validate() resolves null when Solwyn does not answer, and the key details when valid", async () => {
    let up = false;
    const binding = new ProjectBinding({
      selector: TEST_PROJECT,
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      fetch: async () => (up ? authKeyResponse() : new Response("down", { status: 503 })),
      timeoutMs: 1000,
    });
    await expect(binding.validate()).resolves.toBeNull();
    expect(binding.state).toBe("unvalidated");
    up = true;
    await expect(binding.validate()).resolves.toMatchObject({
      project_id: TEST_PROJECT_ID,
      scope: "full",
    });
    up = false;
    // Valid already: an outage keeps the pinned answer.
    await expect(binding.validate()).resolves.toMatchObject({ project_id: TEST_PROJECT_ID });
  });

  it("a same-effect refusal only rewords the stored one; a weaker one from an older dispatch is ignored", async () => {
    const binding = new ProjectBinding({
      selector: TEST_PROJECT,
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      fetch: async () => authKeyResponse(),
      timeoutMs: 1000,
    });
    await binding.validate();
    const old = binding.generation;
    binding.refuse({ code: "api_key_expired", posture: "hard_deny", expiredOn: null }, old);
    const stored = binding.generation;
    binding.refuse({ code: "api_key_invalid", posture: "unknown", expiredOn: null }, old);
    expect(binding.refusal?.code).toBe("api_key_invalid");
    expect(binding.generation).toBe(stored);
    binding.refuse({ code: "api_key_expired", posture: "alert_only", expiredOn: null }, old);
    expect(binding.refusal).toMatchObject({ code: "api_key_invalid", effect: "block" });
  });

  it("logs a refusal once per code", async () => {
    const logger = capture();
    const plane = scripted(() =>
      unauthorized({ code: "api_key_invalid", project_budget_mode: null }),
    );
    const budget = enforcer(plane.fetch, { logger });
    await refusalOf(budget.checkBudget(checkOptions()));
    await refusalOf(budget.binding.validate());
    expect(
      logger.errors.filter((line) => line.startsWith("solwyn.configuration_error.api_key_invalid")),
    ).toHaveLength(1);
  });
});
