/**
 * Review round 1 regressions for API key scoping. Each test reproduces a path that let a provider
 * call run, or kept authority, after the binding should have stopped it:
 *
 * 1. a 401 whose body stalls past the request deadline reached the outage posture;
 * 2. failover hops and same-provider retries dispatched after a refusal was recorded;
 * 3. unmetered spend methods ignored a stored refusal;
 * 4. pinning a different project kept the old project's cached allows and leases;
 * 5. a lease-funded rerun reused its own released call id;
 * 6. a directly constructed BudgetEnforcer ignored SOLWYN_PROJECT.
 */
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { ApiKeyRefusedError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { run } from "../../src/node";
import { FakeControlPlane } from "../../src/testing/index";
import type { FetchLike } from "../../src/transport";
import {
  authKeyResponse,
  expired,
  TEST_API_KEY,
  TEST_API_URL,
  TEST_PROJECT,
  TEST_PROJECT_ID,
} from "../helpers/project-binding";

const AUTH_KEY_PATH = "/api/v1/auth/key";
const CHECK_PATH = "/api/v1/budgets/check";
const LEASE_PATH = "/api/v1/budgets/lease";
const SURRENDER_PATH = "/api/v1/budgets/lease/surrender";
const PROJECT_B = `proj_${"b".repeat(24)}`;

type Body = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function allow(mode: "alert_only" | "hard_deny" = "alert_only", projectId = TEST_PROJECT_ID) {
  return Response.json({
    allowed: true,
    remaining_budget: 90,
    reservation_id: mode === "hard_deny" ? "res-hard" : null,
    mode,
    budget_limit: 100,
    current_usage: 10,
    denied_by_period: null,
    project_id: projectId,
    price_hints: null,
  });
}

function grant(projectId = TEST_PROJECT_ID, leaseId = "lease-a") {
  return Response.json({
    eligible: true,
    allowed: true,
    lease_id: leaseId,
    generation: 1,
    granted_tokens: 200_000,
    refresh_interval_s: 300,
    lease_length_s: 600,
    headroom_share_tokens: 200_000,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: projectId,
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 0,
    remaining_budget: 100,
  });
}

/** A body that sends headers and then never delivers a byte. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
}

/** A fetch whose answers are queued per path; an empty queue falls back to `fallback`. */
function scripted(
  fallback: (path: string, body: Body | undefined) => Response | Promise<Response>,
) {
  const queues = new Map<string, Array<() => Response | Promise<Response>>>();
  const calls: Array<{ path: string; body: Body | undefined }> = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Body) : undefined;
    calls.push({ path, body });
    const next = queues.get(path)?.shift();
    return next === undefined ? fallback(path, body) : next();
  });
  return {
    fetch,
    calls,
    queue(path: string, ...answers: Array<() => Response | Promise<Response>>) {
      queues.set(path, [...(queues.get(path) ?? []), ...answers]);
    },
    count: (path: string) => calls.filter((call) => call.path === path).length,
  };
}

const CHECK = { estimatedInputTokens: 10, model: "gpt-4o", provider: "openai" as const };

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  vi.unstubAllEnvs();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("1. a 401 refuses at its status, before a stalled body can lose the race", () => {
  it("blocks a hard_deny project's call when the 401 body stalls past a 100 ms deadline (failOpen on)", async () => {
    const plane = scripted((path) =>
      path === AUTH_KEY_PATH ? authKeyResponse({ budget_mode: "hard_deny" }) : allow("hard_deny"),
    );
    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
      fetch: plane.fetch,
      failOpen: true,
      cacheTtl: 0,
      leaseEnabled: false,
    });
    closers.push(() => budget.close());
    await budget.binding.validate();
    plane.queue(CHECK_PATH, () => new Response(stalledBody(), { status: 401 }));

    const error = await rejection(budget.checkBudget({ ...CHECK, timeout: 0.1 }));

    expect(error).toBeInstanceOf(ApiKeyRefusedError);
    expect(budget.binding.refusal).toMatchObject({ code: "api_key_invalid", effect: "block" });
  });

  it("refines the provisional refusal once a slow 401 body arrives inside the deadline", async () => {
    const plane = scripted((path) =>
      path === AUTH_KEY_PATH ? authKeyResponse() : allow("alert_only"),
    );
    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
      fetch: plane.fetch,
      cacheTtl: 0,
      leaseEnabled: false,
    });
    closers.push(() => budget.close());
    await budget.binding.validate();
    const body = expired("alert_only");
    const text = await body.text();
    plane.queue(
      CHECK_PATH,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await new Promise((resolve) => setTimeout(resolve, 30));
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          }),
          { status: 401 },
        ),
    );
    await expect(budget.checkBudget({ ...CHECK, timeout: 2 })).resolves.toMatchObject({
      allowed: true,
      reservationId: null,
    });
    expect(budget.binding.refusal).toMatchObject({
      code: "api_key_expired",
      posture: "alert_only",
      effect: "allow_unmetered",
    });
  });
});

/** An OpenAI-shaped provider whose first create stays pending until the test settles it. */
function pendingProvider(stream = false) {
  const first = deferred<unknown>();
  let calls = 0;
  const create = vi.fn((_kwargs: Body) => {
    calls += 1;
    if (calls === 1) return first.promise;
    if (stream) {
      return (async function* () {
        yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      })();
    }
    return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  return { client: { chat: { completions: { create } } }, create, first };
}

function rateLimited(): Error {
  return Object.assign(new Error("rate limited"), {
    status: 429,
    headers: { "retry-after": "0" },
  });
}

describe("2. every physical provider dispatch re-checks the binding", () => {
  it.each([
    ["buffered failover on an alert_only project", "alert_only", false, false],
    ["streaming failover on an alert_only project", "alert_only", true, false],
    ["buffered failover funded by a hard_deny lease", "hard_deny", false, true],
  ] as const)("blocks a %s after a refusal recorded while the primary was pending", async (_label, mode, stream, lease) => {
    const plane = new FakeControlPlane({ mode, postureMode: mode });
    const primary = pendingProvider(stream);
    const fallback = pendingProvider(stream);
    fallback.first.resolve({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const wrapped = plane.wrap(primary.client, {
      leaseEnabled: lease,
      reportUntrackedSurfaces: false,
      failoverIdempotency: "always",
      fallback: [[fallback.client, "gpt-4o-mini"]],
    });
    closers.push(() => wrapped.close());
    const call = (): Promise<unknown> =>
      (
        wrapped as unknown as {
          chat: { completions: { create(body: Body): Promise<unknown> } };
        }
      ).chat.completions.create({ model: "gpt-4o", messages: [], stream });
    const pending = lease ? run("refusal-failover", call) : call();
    await vi.waitFor(() => expect(primary.create).toHaveBeenCalledOnce());

    plane.revokeKey({ projectBudgetMode: "hard_deny" });
    await expect(wrapped.validate()).rejects.toBeInstanceOf(ApiKeyRefusedError);
    primary.first.reject(rateLimited());

    expect(await rejection(pending)).toBeInstanceOf(ApiKeyRefusedError);
    expect(fallback.create).not.toHaveBeenCalled();
  });

  it("blocks a same-provider retry under a per-call hard_deny admission", async () => {
    const plane = new FakeControlPlane({ mode: "hard_deny" });
    const primary = pendingProvider();
    const wrapped = plane.wrap(primary.client, {
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      sameProviderRetries: 1,
    });
    closers.push(() => wrapped.close());
    const pending = (
      wrapped as unknown as { chat: { completions: { create(body: Body): Promise<unknown> } } }
    ).chat.completions.create({ model: "gpt-4o", messages: [], max_tokens: 10 });
    await vi.waitFor(() => expect(primary.create).toHaveBeenCalledOnce());

    plane.revokeKey({ projectBudgetMode: "hard_deny" });
    await expect(wrapped.validate()).rejects.toBeInstanceOf(ApiKeyRefusedError);
    primary.first.reject(rateLimited());

    expect(await rejection(pending)).toBeInstanceOf(ApiKeyRefusedError);
    expect(primary.create).toHaveBeenCalledOnce();
    // The per-call reservation was settled at zero usage, not left funding a dead call.
    await wrapped.close();
    expect(plane.confirms.length).toBeLessThanOrEqual(1);
  });
});

describe("3. unmetered spend methods enforce a stored refusal", () => {
  function openai() {
    const requests: string[] = [];
    const provider = new OpenAI({
      apiKey: "synthetic-unused",
      maxRetries: 0,
      fetch: (async (url: string) => {
        requests.push(String(url));
        return Response.json({ id: "batch_synthetic", object: "batch" });
      }) as unknown as typeof globalThis.fetch,
    });
    return { provider, requests };
  }

  it("refuses batches.create after validate() rejected a read-only key, under the default posture", async () => {
    const plane = new FakeControlPlane({ keyScope: "read_only" });
    const { provider, requests } = openai();
    const wrapped = plane.wrap(provider, { reportUntrackedSurfaces: false });
    closers.push(() => wrapped.close());
    const before = wrapped.batches.create;

    await expect(wrapped.validate()).rejects.toBeInstanceOf(ApiKeyRefusedError);

    expect(
      await rejection(
        Promise.resolve().then(() =>
          wrapped.batches.create({
            input_file_id: "file-synthetic",
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
          }),
        ),
      ),
    ).toBeInstanceOf(ApiKeyRefusedError);
    expect(
      await rejection(
        Promise.resolve().then(() =>
          before.call(wrapped.batches, {
            input_file_id: "file-synthetic",
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
          }),
        ),
      ),
    ).toBeInstanceOf(ApiKeyRefusedError);
    expect(requests).toEqual([]);
  });

  it("an acknowledgment never overrides a key refusal", async () => {
    const plane = new FakeControlPlane({ keyScope: "read_only" });
    const { provider, requests } = openai();
    const wrapped = plane.wrap(provider, {
      reportUntrackedSurfaces: false,
      onUnmetered: "allow",
      acknowledgeUntracked: ["batches.create"],
    });
    closers.push(() => wrapped.close());
    const before = wrapped.batches.create;
    await expect(wrapped.validate()).rejects.toBeInstanceOf(ApiKeyRefusedError);
    expect(
      await rejection(
        Promise.resolve().then(() =>
          before.call(wrapped.batches, {
            input_file_id: "file-synthetic",
            endpoint: "/v1/chat/completions",
            completion_window: "24h",
          }),
        ),
      ),
    ).toBeInstanceOf(ApiKeyRefusedError);
    expect(requests).toEqual([]);
  });
});

describe("4. retained authority is tied to the pinned project", () => {
  it("drops project A's cached allow and lease when validation pins project B", async () => {
    let now = 0;
    const plane = scripted((path) => {
      if (path === AUTH_KEY_PATH) return authKeyResponse({ project_id: PROJECT_B });
      if (path === LEASE_PATH) return grant(PROJECT_B, "lease-b");
      if (path === SURRENDER_PATH) return Response.json({ released: true });
      return allow("alert_only", PROJECT_B);
    });
    plane.queue(AUTH_KEY_PATH, () => Promise.reject(new TypeError("fetch failed")));
    plane.queue(CHECK_PATH, () => allow("alert_only"));
    plane.queue(LEASE_PATH, () => grant());
    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
      fetch: plane.fetch,
      monotonicNow: () => now,
      cacheTtl: 600,
    });
    closers.push(() => budget.close());

    // Unvalidated: authority acquired for whatever the name resolves to (project A).
    await budget.checkBudget(CHECK);
    expect((await budget.checkBudget({ ...CHECK, agentRunId: "run-a" })).leaseId).toBe("lease-a");
    expect(plane.count(CHECK_PATH)).toBe(1);
    await budget.checkBudget(CHECK);
    expect(plane.count(CHECK_PATH)).toBe(1);

    // The name now means project B; the retried validation pins B.
    now += 30_000;
    await budget.checkBudget(CHECK);
    expect(budget.binding.pinnedId).toBe(PROJECT_B);
    expect(plane.count(CHECK_PATH)).toBe(2);
    const leased = await budget.checkBudget({ ...CHECK, agentRunId: "run-a" });
    expect(leased.leaseId).toBe("lease-b");
    expect(plane.calls.filter((call) => call.path === SURRENDER_PATH)).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ lease_id: "lease-a" }) }),
    ]);
  });

  it("never installs a lease granted under authority dropped while the grant was in flight", async () => {
    let now = 0;
    const plane = scripted((path) => {
      if (path === AUTH_KEY_PATH) return authKeyResponse({ project_id: PROJECT_B });
      if (path === SURRENDER_PATH) return Response.json({ released: true });
      return allow("alert_only", PROJECT_B);
    });
    const late = deferred<Response>();
    plane.queue(AUTH_KEY_PATH, () => Promise.reject(new TypeError("fetch failed")));
    plane.queue(LEASE_PATH, () => late.promise);
    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
      fetch: plane.fetch,
      monotonicNow: () => now,
      cacheTtl: 0,
    });
    closers.push(() => budget.close());
    const leasedCall = budget.checkBudget({ ...CHECK, agentRunId: "run-late", timeout: 120 });
    await vi.waitFor(() => expect(plane.count(LEASE_PATH)).toBe(1));

    now += 30_000;
    await budget.checkBudget(CHECK);
    expect(budget.binding.pinnedId).toBe(PROJECT_B);
    late.resolve(grant(TEST_PROJECT_ID, "lease-late"));

    // Item 5 too: the re-run must not reuse the released lease call id.
    const result = await leasedCall;
    expect(result.allowed).toBe(true);
    expect(result.leaseId).toBeNull();
    await vi.waitFor(() =>
      expect(plane.calls.filter((call) => call.path === SURRENDER_PATH)).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ lease_id: "lease-late" }) }),
      ]),
    );
  });
});

describe("5. a lease-funded rerun keeps its call id usable", () => {
  it("re-runs per call after a concurrent validation succeeds while the initial grant is pending", async () => {
    let now = 0;
    const plane = scripted((path) => {
      if (path === AUTH_KEY_PATH) return authKeyResponse();
      if (path === SURRENDER_PATH) return Response.json({ released: true });
      return allow("alert_only");
    });
    const pendingGrant = deferred<Response>();
    plane.queue(AUTH_KEY_PATH, () => Promise.reject(new TypeError("fetch failed")));
    plane.queue(LEASE_PATH, () => pendingGrant.promise);
    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
      fetch: plane.fetch,
      monotonicNow: () => now,
      cacheTtl: 0,
    });
    closers.push(() => budget.close());
    const callId = "00000000-0000-4000-8000-0000000000a5";
    const leased = budget.checkBudget({
      ...CHECK,
      agentRunId: "run-rerun",
      callId,
      timeout: 120,
    });
    await vi.waitFor(() => expect(plane.count(LEASE_PATH)).toBe(1));
    now += 30_000;
    await budget.checkBudget(CHECK);
    pendingGrant.resolve(grant());

    await expect(leased).resolves.toMatchObject({ allowed: true, callId });
    // One check for the concurrent call, one per-call re-run for the leased call.
    expect(plane.count(CHECK_PATH)).toBe(2);
  });
});

describe("6. a directly constructed BudgetEnforcer reads SOLWYN_PROJECT", () => {
  it("falls back to SOLWYN_PROJECT, and the option still wins", () => {
    vi.stubEnv("SOLWYN_PROJECT", "env-project");
    const fromEnv = new BudgetEnforcer({ apiUrl: TEST_API_URL, apiKey: TEST_API_KEY });
    expect(fromEnv.binding.selector).toBe("env-project");
    const fromOption = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: "option-project",
    });
    expect(fromOption.binding.selector).toBe("option-project");
    vi.stubEnv("SOLWYN_PROJECT", undefined);
    expect(() => new BudgetEnforcer({ apiUrl: TEST_API_URL, apiKey: TEST_API_KEY })).toThrow(
      "No Solwyn project configured.",
    );
  });
});

describe("review 2.1: a provisional 401 loses ownership to any newer definitive refusal", () => {
  it("an older slow alert_only 401 body cannot relax a newer malformed 401's refusal", async () => {
    const firstHeaders = deferred<Response>();
    const secondHeaders = deferred<Response>();
    const bothChecks = deferred<void>();
    const firstBodyRead = deferred<void>();
    let checks = 0;
    let dispatches = 0;
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const provider = {
      chat: {
        completions: {
          create() {
            dispatches += 1;
            return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
          },
        },
      },
    };
    const wrapped = new Solwyn(provider, {
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      project: TEST_PROJECT,
      leaseEnabled: false,
      budgetCheckCacheTtl: 0,
      reportUntrackedSurfaces: false,
      logger: noopLogger,
      fetch: async (url) => {
        const path = new URL(url).pathname;
        if (path === AUTH_KEY_PATH) return authKeyResponse();
        if (path === CHECK_PATH) {
          checks += 1;
          if (checks === 1) return firstHeaders.promise;
          if (checks === 2) {
            bothChecks.resolve();
            return secondHeaders.promise;
          }
          throw new Error("unexpected fresh check");
        }
        return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
      },
    });
    closers.push(() => wrapped.close());
    await wrapped.validate();
    const create = (): Promise<unknown> =>
      (
        wrapped as unknown as { chat: { completions: { create(body: Body): Promise<unknown> } } }
      ).chat.completions.create({ model: "synthetic" });

    const a = rejection(create());
    const b = rejection(create());
    await bothChecks.promise;
    firstHeaders.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          pull() {
            firstBodyRead.resolve();
          },
        }),
        { status: 401 },
      ),
    );
    await firstBodyRead.promise;
    secondHeaders.resolve(new Response("malformed JSON", { status: 401 }));
    expect(await b).toBeInstanceOf(ApiKeyRefusedError);
    bodyController.enqueue(new TextEncoder().encode(await expired("alert_only").text()));
    bodyController.close();

    expect(await a).toBeInstanceOf(ApiKeyRefusedError);
    expect(await rejection(create())).toBeInstanceOf(ApiKeyRefusedError);
    expect(dispatches).toBe(0);
  });
});

describe("review 2.2: raw native dispatches re-check the binding immediately before the call", () => {
  it.each([
    0, 2, 3, 8,
  ])("decisions.create never runs after a read_only_key recorded after its budget check (gap %i)", async (gap) => {
    let refused = false;
    let calledAfterRefusal = false;
    let auths = 0;
    const auth = deferred<Response>();
    const check = deferred<Response>();
    const checkStarted = deferred<void>();
    const raw = new OpenAI({
      apiKey: "offline-synthetic",
      maxRetries: 0,
      fetch: (async () => Response.json({ id: "dec_synthetic" })) as unknown as typeof fetch,
    });
    const nativeCreate = raw.decisions.create;
    raw.decisions.create = function (this: unknown, ...args: unknown[]) {
      calledAfterRefusal ||= refused;
      return Reflect.apply(nativeCreate, this, args);
    } as typeof raw.decisions.create;
    const plane = new FakeControlPlane();
    const client = new Solwyn(raw, {
      apiKey: plane.apiKey,
      project: plane.project,
      apiUrl: plane.apiUrl,
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      logger: {
        ...noopLogger,
        error: (line: string) => {
          if (line.startsWith("solwyn.configuration_error.read_only_key:")) refused = true;
        },
      },
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === AUTH_KEY_PATH) {
          auths += 1;
          return auths === 1 ? authKeyResponse() : auth.promise;
        }
        if (path === CHECK_PATH) {
          checkStarted.resolve();
          return check.promise;
        }
        return plane.fetch(url, init);
      },
    });
    closers.push(() => client.close());
    await client.validate();
    const validating = rejection(client.validate());
    const decision = rejection(
      Promise.resolve().then(() =>
        client.decisions.create({ model: "synthetic", input: "synthetic" } as never),
      ),
    );
    await checkStarted.promise;
    check.resolve(allow("alert_only"));
    for (let turn = 0; turn < gap; turn++) await Promise.resolve();
    auth.resolve(authKeyResponse({ scope: "read_only" }));

    await decision;
    expect(await validating).toBeInstanceOf(ApiKeyRefusedError);
    expect(calledAfterRefusal).toBe(false);
  });

  it("an unrecognised Bedrock command carrying input.modelId stops on a stored refusal", async () => {
    class BedrockRuntimeClient {
      readonly meta = {
        service_model: { service_name: "bedrock-runtime" },
        region_name: "us-east-1",
      };
      constructor(readonly send: (command: unknown) => unknown) {}
    }
    class CountTokensCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    const send = vi.fn((_command: unknown) => ({ ok: true }));
    const plane = new FakeControlPlane({ keyScope: "read_only" });
    const client = plane.wrap(new BedrockRuntimeClient(send), {
      reportUntrackedSurfaces: false,
      logger: noopLogger,
    });
    closers.push(() => client.close());
    await expect(client.validate()).rejects.toBeInstanceOf(ApiKeyRefusedError);
    const sendThrough = (client as unknown as { send(command: unknown): Promise<unknown> }).send;
    expect(
      await rejection(
        Promise.resolve().then(() =>
          sendThrough(new CountTokensCommand({ modelId: "anthropic.synthetic" })),
        ),
      ),
    ).toBeInstanceOf(ApiKeyRefusedError);
    expect(send).not.toHaveBeenCalled();
  });
});
