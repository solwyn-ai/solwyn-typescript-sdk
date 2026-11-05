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
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { ApiKeyRefusedError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { run } from "../../src/node";
import { ProjectBinding } from "../../src/project";
import { MetadataReporter } from "../../src/reporter";
import { FakeControlPlane } from "../../src/testing/index";
import { zeroTokenDetails } from "../../src/token-details";
import { type FetchLike, Transport } from "../../src/transport";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";
import {
  authKeyResponse,
  expired,
  TEST_API_KEY,
  TEST_API_URL,
  TEST_PROJECT,
  TEST_PROJECT_ID,
  testBinding,
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
    // The revalidation started at the 401 sees the same refused key.
    plane.queue(AUTH_KEY_PATH, () => expired("hard_deny"));

    const error = await rejection(budget.checkBudget({ ...CHECK, timeout: 0.1 }));

    expect(error).toBeInstanceOf(ApiKeyRefusedError);
    // Blocking from the status on; the revalidation it started may reword it (here: expired).
    expect(budget.binding.refusal).toMatchObject({ effect: "block" });
  });

  it("a slow alert_only 401 body never relaxes its own block; the revalidation started at the 401 does", async () => {
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
    const text = await expired("alert_only").text();
    const revalidation = deferred<Response>();
    plane.queue(AUTH_KEY_PATH, () => revalidation.promise);
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
    // The status blocked; the body (alert_only) arrived inside the deadline but cannot relax it.
    expect(await rejection(budget.checkBudget({ ...CHECK, timeout: 2 }))).toBeInstanceOf(
      ApiKeyRefusedError,
    );
    expect(budget.binding.refusal).toMatchObject({ effect: "block" });
    expect(plane.count(AUTH_KEY_PATH)).toBe(2);

    revalidation.resolve(expired("alert_only"));
    await vi.waitFor(() =>
      expect(budget.binding.refusal).toMatchObject({
        code: "api_key_expired",
        posture: "alert_only",
        effect: "allow_unmetered",
      }),
    );
    await expect(budget.checkBudget(CHECK)).resolves.toMatchObject({
      allowed: true,
      reservationId: null,
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
    let auths = 0;
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
        if (path === AUTH_KEY_PATH) {
          auths += 1;
          return auths === 1 ? authKeyResponse() : new Response("malformed JSON", { status: 401 });
        }
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

/** A 401 whose body is held until the test finishes it; `reading` resolves when it is read. */
function slow401() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reading = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const response = new Response(stream, { status: 401 });
  Object.defineProperty(response, "body", {
    get() {
      reading.resolve();
      return stream;
    },
  });
  return {
    response,
    reading,
    finish(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
}

describe("review 3.1: a 401 only tightens; only a revalidation sent after it relaxes", () => {
  it("two overlapping 401s: the older alert_only body cannot relax while the newer one is unread", async () => {
    const headersA = deferred<Response>();
    const headersB = deferred<Response>();
    const both = deferred<void>();
    const revalidation = deferred<Response>();
    const a401 = slow401();
    const b401 = slow401();
    let checks = 0;
    let auths = 0;
    let dispatches = 0;
    const raw = {
      chat: {
        completions: {
          create() {
            dispatches += 1;
            return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
          },
        },
      },
    };
    const client = new Solwyn(raw, {
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      project: TEST_PROJECT,
      leaseEnabled: false,
      budgetCheckCacheTtl: 0,
      logger: noopLogger,
      reportUntrackedSurfaces: false,
      fetch: async (url) => {
        const path = new URL(url).pathname;
        if (path === AUTH_KEY_PATH) {
          auths += 1;
          return auths === 1 ? authKeyResponse() : revalidation.promise;
        }
        if (path === CHECK_PATH) {
          checks += 1;
          if (checks === 1) return headersA.promise;
          if (checks === 2) {
            both.resolve();
            return headersB.promise;
          }
          throw new Error("unexpected fresh budget check");
        }
        return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
      },
    });
    closers.push(() => client.close());
    const create = (): Promise<unknown> =>
      rejection(
        (
          client as unknown as { chat: { completions: { create(b: Body): Promise<unknown> } } }
        ).chat.completions.create({ model: "synthetic" }),
      );
    await client.validate();
    const a = create();
    const b = create();
    await both.promise;
    headersA.resolve(a401.response);
    await a401.reading.promise;
    headersB.resolve(b401.response);
    await b401.reading.promise;
    expect(await create()).toBeInstanceOf(ApiKeyRefusedError);

    a401.finish(await expired("alert_only").text());
    expect(await a).toBeInstanceOf(ApiKeyRefusedError);
    expect(await create()).toBeInstanceOf(ApiKeyRefusedError);
    expect(dispatches).toBe(0);

    b401.finish(await expired("hard_deny").text());
    expect(await b).toBeInstanceOf(ApiKeyRefusedError);
    revalidation.resolve(expired("hard_deny"));
    await vi.waitFor(() => expect(auths).toBe(2));
    expect(await create()).toBeInstanceOf(ApiKeyRefusedError);
    expect(dispatches).toBe(0);
  });

  it("a cancelled overlapping 401 stays blocking after the other 401's alert_only body arrives", async () => {
    const revalidation = deferred<Response>();
    let auths = 0;
    const binding = testBinding({
      fetch: async () => {
        auths += 1;
        return auths === 1 ? authKeyResponse() : revalidation.promise;
      },
    });
    await binding.validate();
    const a = slow401();
    const b = slow401();
    const headersA = deferred<Response>();
    const headersB = deferred<Response>();
    const transportA = new Transport(TEST_API_URL, TEST_API_KEY, {
      binding,
      fetch: () => headersA.promise,
    });
    const transportB = new Transport(TEST_API_URL, TEST_API_KEY, {
      binding,
      fetch: () => headersB.promise,
    });
    const cancel = new AbortController();
    const pendingA = rejection(transportA.postJson(CHECK_PATH, {}, { timeoutMs: 2000 }));
    const pendingB = rejection(
      transportB.postJson(CHECK_PATH, {}, { timeoutMs: 2000, signal: cancel.signal }),
    );
    headersA.resolve(a.response);
    await a.reading.promise;
    headersB.resolve(b.response);
    await b.reading.promise;
    cancel.abort();
    await pendingB;
    a.finish(await expired("alert_only").text());
    await pendingA;
    expect(binding.blockingRefusal()).toBeInstanceOf(ApiKeyRefusedError);

    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      binding,
      leaseEnabled: false,
      fetch: async () => {
        throw new Error("no fresh network expected");
      },
    });
    closers.push(() => budget.close());
    expect(await rejection(budget.checkBudget(CHECK))).toBeInstanceOf(ApiKeyRefusedError);
    b.finish(await expired("hard_deny").text());
    revalidation.resolve(expired("hard_deny"));
  });

  it("an alert_only project relaxes promptly through the revalidation started at the 401", async () => {
    const plane = new FakeControlPlane({ mode: "alert_only" });
    const upstream = pendingProvider();
    upstream.first.resolve({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const wrapped = plane.wrap(upstream.client, {
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      logger: noopLogger,
    });
    closers.push(() => wrapped.close());
    const create = (): Promise<unknown> =>
      (
        wrapped as unknown as { chat: { completions: { create(b: Body): Promise<unknown> } } }
      ).chat.completions.create({ model: "gpt-4o", messages: [] });
    await create();
    plane.expireKey({ projectBudgetMode: "alert_only" });
    // This call's check gets the 401; it is blocked unless the prompt revalidation has already
    // relaxed the refusal by its exit check (the deterministic window is covered by F7b).
    await rejection(create());
    // No 60 s wait (real clock, well under a second): calls run unmetered again.
    const before = upstream.create.mock.calls.length;
    await vi.waitFor(async () => {
      await create();
    });
    expect(upstream.create.mock.calls.length).toBeGreaterThan(before);
    expect(plane.checks.length).toBe(1);
  });
});

describe("review 3.2: deferred and returned spend is fenced at its actual dispatch", () => {
  const chunk = {
    id: "chatcmpl-synthetic",
    object: "chat.completion.chunk",
    created: 0,
    model: "synthetic",
    choices: [
      { index: 0, delta: { role: "assistant", content: "synthetic" }, finish_reason: null },
    ],
  };
  const end = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const sse = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`;

  it.each([
    "chat.completions.stream",
    "responses.stream",
    "batches.await",
    "batches.withResponse",
    "batches.asResponse",
  ] as const)("%s created before a refusal never dispatches after it", async (kind) => {
    let refused = false;
    let auths = 0;
    const requests: Array<{ afterRefusal: boolean; url: string }> = [];
    const prepared = deferred<void>();
    const release = deferred<void>();
    const raw = new OpenAI({
      apiKey: "offline-synthetic",
      maxRetries: 0,
      fetch: (async (url: string) => {
        requests.push({ afterRefusal: refused, url: String(url) });
        return kind === "chat.completions.stream"
          ? new Response(sse, { headers: { "content-type": "text/event-stream" } })
          : Response.json({ id: "batch_synthetic", object: "batch" });
      }) as unknown as typeof fetch,
    });
    if (kind.startsWith("batches")) {
      (raw as unknown as { prepareOptions: () => Promise<void> }).prepareOptions = async () => {
        prepared.resolve();
        await release.promise;
      };
    }
    const client = new Solwyn(raw, {
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      project: TEST_PROJECT,
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      logger: noopLogger,
      fetch: async (url) => {
        if (new URL(url).pathname !== AUTH_KEY_PATH) {
          return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
        }
        auths += 1;
        return auths === 1 ? authKeyResponse() : authKeyResponse({ scope: "read_only" });
      },
    });
    closers.push(() => client.close());
    await client.validate();
    // biome-ignore lint/suspicious/noExplicitAny: the probe drives several native helper shapes.
    let handle: any;
    if (kind === "chat.completions.stream") {
      handle = client.chat.completions.stream({ model: "synthetic", messages: [] });
    } else if (kind === "responses.stream") {
      handle = client.responses.stream({ model: "synthetic", input: "synthetic" });
    } else {
      handle = client.batches.create({
        input_file_id: "file-synthetic",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      });
      await prepared.promise;
    }
    expect(await rejection(client.validate())).toBeInstanceOf(ApiKeyRefusedError);
    refused = true;
    release.resolve();
    const consumed = rejection(
      Promise.resolve().then(() => {
        if (kind === "chat.completions.stream") return handle.finalChatCompletion();
        if (kind === "responses.stream") return handle.finalResponse();
        if (kind === "batches.withResponse") return handle.withResponse();
        if (kind === "batches.asResponse") return handle.asResponse();
        return handle;
      }),
    );
    expect(await consumed).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.filter((request) => request.afterRefusal)).toEqual([]);
  });

  it("a Google chat handle created before a refusal never sends after it", async () => {
    const providerRequests: string[] = [];
    const raw = new GoogleGenAI({
      apiKey: "offline-synthetic",
      httpOptions: {
        fetch: async (url: string) => {
          providerRequests.push(String(url));
          return Response.json({
            candidates: [
              { content: { role: "model", parts: [{ text: "synthetic" }] }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          });
        },
      } as never,
    });
    const plane = new FakeControlPlane({ keyScope: "read_only" });
    const wrapped = plane.wrap(raw, { reportUntrackedSurfaces: false });
    closers.push(() => wrapped.close());
    const chat = wrapped.chats.create({ model: "gemini-synthetic" });
    await expect(wrapped.validate()).rejects.toBeInstanceOf(ApiKeyRefusedError);
    expect(
      await rejection(Promise.resolve().then(() => chat.sendMessage({ message: "synthetic" }))),
    ).toBeInstanceOf(ApiKeyRefusedError);
    expect(providerRequests).toEqual([]);
  });
});

describe("while refused, only the key check goes to Solwyn", () => {
  function refusedEnforcer() {
    let now = 0;
    const plane = scripted((path) => {
      if (path === AUTH_KEY_PATH) return authKeyResponse();
      if (path === SURRENDER_PATH) return Response.json({ released: true });
      return allow("alert_only");
    });
    const budget = new BudgetEnforcer({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      project: TEST_PROJECT,
      fetch: plane.fetch,
      monotonicNow: () => now,
      cacheTtl: 0,
      leaseEnabled: false,
    });
    closers.push(() => budget.close());
    return {
      plane,
      budget,
      advance(ms: number) {
        now += ms;
      },
      dataPlaneSince(index: number) {
        return plane.calls.slice(index).filter((call) => call.path !== AUTH_KEY_PATH);
      },
    };
  }

  it("(a) an allow_unmetered client stays unmetered; only a request sent before the refusal can blip it, and the immediate revalidation relaxes it", async () => {
    const { plane, budget, advance, dataPlaneSince } = refusedEnforcer();
    await budget.binding.validate();
    // Check A is in flight while the key is still valid.
    const lateA = deferred<Response>();
    plane.queue(CHECK_PATH, () => lateA.promise);
    const callA = budget.checkBudget(CHECK);
    await vi.waitFor(() => expect(plane.count(CHECK_PATH)).toBe(1));

    // Check B gets the alert_only 401: a block at its status, relaxed by the revalidation.
    plane.queue(CHECK_PATH, () => expired("alert_only"));
    plane.queue(AUTH_KEY_PATH, () => expired("alert_only"));
    await rejection(budget.checkBudget(CHECK));
    await vi.waitFor(() =>
      expect(budget.binding.refusal).toMatchObject({ effect: "allow_unmetered" }),
    );
    const mark = plane.calls.length;

    // A, sent before the refusal, answers 401 late: a one-time blip, then the revalidation it
    // triggers (at once, not after 60 s) relaxes again.
    const authBefore = plane.count(AUTH_KEY_PATH);
    const relax = deferred<Response>();
    plane.queue(AUTH_KEY_PATH, () => relax.promise);
    lateA.resolve(new Response(stalledBody(), { status: 401 }));
    await vi.waitFor(() => expect(budget.binding.refusal?.effect).toBe("block"));
    relax.resolve(expired("alert_only"));
    await vi.waitFor(() =>
      expect(budget.binding.refusal).toMatchObject({ effect: "allow_unmetered" }),
    );
    expect(plane.count(AUTH_KEY_PATH)).toBe(authBefore + 1);
    await rejection(callA);

    // No periodic re-blocks: every 60 s revalidation keeps it unmetered; calls never block.
    for (let round = 0; round < 3; round++) {
      advance(60_000);
      plane.queue(AUTH_KEY_PATH, () => expired("alert_only"));
      for (let call = 0; call < 5; call++) {
        await expect(budget.checkBudget(CHECK)).resolves.toMatchObject({ allowed: true });
      }
      expect(budget.binding.refusal).toMatchObject({ effect: "allow_unmetered" });
    }
    expect(dataPlaneSince(mark)).toEqual([]);
  });

  it("(b) a 401-triggered revalidation ignores the 60 s cadence; a revalidation answered with a refusal backs off 60 s", async () => {
    const { plane, budget, advance } = refusedEnforcer();
    await budget.binding.validate();
    plane.queue(CHECK_PATH, () => expired("hard_deny"));
    plane.queue(AUTH_KEY_PATH, () => expired("hard_deny"));
    await rejection(budget.checkBudget(CHECK));
    // Immediate: no time passed.
    await vi.waitFor(() => expect(plane.count(AUTH_KEY_PATH)).toBe(2));
    // That revalidation answered with a refusal: the gate waits the full 60 s.
    for (let call = 0; call < 3; call++) await rejection(budget.checkBudget(CHECK));
    advance(59_999);
    await rejection(budget.checkBudget(CHECK));
    expect(plane.count(AUTH_KEY_PATH)).toBe(2);
    advance(1);
    plane.queue(AUTH_KEY_PATH, () => expired("hard_deny"));
    await rejection(budget.checkBudget(CHECK));
    expect(plane.count(AUTH_KEY_PATH)).toBe(3);
  });

  it("(c) a revalidation answered 200 full-scope clears the refusal and data-plane traffic resumes", async () => {
    const { plane, budget, advance } = refusedEnforcer();
    await budget.binding.validate();
    plane.queue(CHECK_PATH, () => expired("hard_deny"));
    plane.queue(AUTH_KEY_PATH, () => expired("hard_deny"));
    await rejection(budget.checkBudget(CHECK));
    await vi.waitFor(() => expect(plane.count(AUTH_KEY_PATH)).toBe(2));
    const checksWhileRefused = plane.count(CHECK_PATH);
    await rejection(budget.checkBudget(CHECK));
    expect(plane.count(CHECK_PATH)).toBe(checksWhileRefused);

    advance(60_000);
    await expect(budget.checkBudget(CHECK)).resolves.toMatchObject({ allowed: true });
    expect(budget.binding.state).toBe("valid");
    expect(plane.count(CHECK_PATH)).toBe(checksWhileRefused + 1);
  });

  it("allow_unmetered client making 100 calls with background reporters sends zero data-plane requests and never blocks", async () => {
    let auths = 0;
    const requests: string[] = [];
    let dispatches = 0;
    const raw = {
      chat: {
        completions: {
          create() {
            dispatches += 1;
            return { usage: { prompt_tokens: 3, completion_tokens: 2 } };
          },
        },
      },
    };
    const client = new Solwyn(raw, {
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      project: TEST_PROJECT,
      leaseEnabled: true,
      budgetCheckCacheTtl: 0,
      reporterFlushInterval: 0.01,
      breakerReportHeartbeat: 0.01,
      reportUntrackedSurfaces: true,
      logger: noopLogger,
      fetch: async (url) => {
        const path = new URL(url).pathname;
        requests.push(path);
        if (path === AUTH_KEY_PATH) {
          auths += 1;
          return auths === 1 ? authKeyResponse() : expired("alert_only");
        }
        if (path === CHECK_PATH) return allow("alert_only");
        if (path === LEASE_PATH) return grant();
        return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
      },
    });
    closers.push(() => client.close());
    const create = (): Promise<unknown> =>
      (
        client as unknown as { chat: { completions: { create(b: Body): Promise<unknown> } } }
      ).chat.completions.create({ model: "gpt-4o", messages: [] });

    await client.validate();
    await create();
    // The key expires on an alerts-only project; the next check learns it.
    expect(await rejection(client.validate())).toBeInstanceOf(ApiKeyRefusedError);
    const mark = requests.length;

    for (let call = 0; call < 100; call++) await expect(create()).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.close();

    expect(dispatches).toBe(101);
    expect(requests.slice(mark).filter((path) => path !== AUTH_KEY_PATH)).toEqual([]);
  });
});

describe("refused drops are local and counted", () => {
  it("confirms and events queued while refused are dropped without a request and counted as api_key_refused", async () => {
    const binding = testBinding({ fetch: async () => expired("hard_deny") });
    await expect(binding.validate()).rejects.toBeInstanceOf(ApiKeyRefusedError);
    const sent: string[] = [];
    const reporter = new MetadataReporter(TEST_API_URL, TEST_API_KEY, {
      binding,
      fetch: async (url) => {
        sent.push(new URL(url).pathname);
        return new Response(null, { status: 204 });
      },
    });
    closers.push(() => reporter.close(0));
    reporter.reportConfirm(
      BudgetConfirmRequestSchema.parse({
        reservation_id: "r-refused",
        model: "gpt-4o",
        provider: "openai",
        call_id: "00000000-0000-4000-8000-0000000000d1",
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
        call_id: "00000000-0000-4000-8000-0000000000d2",
        sdk_instance_id: "sdk-refused",
        timestamp: "2026-11-05T00:00:00Z",
      }),
    );
    await reporter._flushRemaining();
    expect(sent).toEqual([]);
    expect(reporter.droppedCounts).toMatchObject({
      "confirm.api_key_refused": 1,
      "event.api_key_refused": 1,
    });
  });
});

describe("review 4.1: an independent same-strength refusal advances ordering", () => {
  it.each([
    "alert_only",
    "full_scope",
  ] as const)("a key check sent before a newer independent block cannot relax or clear it (answer %s)", async (answer) => {
    const revalidate = deferred<Response>();
    const started = deferred<void>();
    const aHeaders = deferred<Response>();
    const bHeaders = deferred<Response>();
    let auths = 0;
    const binding = new ProjectBinding({
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      selector: TEST_PROJECT,
      timeoutMs: 2000,
      fetch: async () => {
        auths += 1;
        if (auths === 1) return authKeyResponse();
        started.resolve();
        return revalidate.promise;
      },
    });
    await binding.validate();
    let calls = 0;
    const transport = new Transport(TEST_API_URL, TEST_API_KEY, {
      binding,
      fetch: async () => {
        calls += 1;
        return calls === 1 ? aHeaders.promise : bHeaders.promise;
      },
    });
    const a = rejection(transport.postJson(CHECK_PATH, {}, { timeoutMs: 2000 }));
    const b = rejection(transport.postJson(CHECK_PATH, {}, { timeoutMs: 2000 }));
    aHeaders.resolve(new Response("invalid JSON", { status: 401 }));
    await started.promise;
    await a;
    bHeaders.resolve(expired("hard_deny"));
    await b;
    revalidate.resolve(answer === "alert_only" ? expired("alert_only") : authKeyResponse());
    await binding.revalidate();
    expect(await rejection(binding.gate())).toBeInstanceOf(ApiKeyRefusedError);
  });
});

describe("review 4.2: derived clients keep the fence through nested namespaces", () => {
  it.each([
    "derived-namespace-after-refusal",
    "derived-deferred-before-refusal",
    "raw-post-deferred-control",
  ] as const)("%s never dispatches after a refusal", async (mode) => {
    let refused = false;
    let auths = 0;
    const requests: Array<{ afterRefusal: boolean }> = [];
    const prepared = deferred<void>();
    const release = deferred<void>();
    const raw = new OpenAI({
      apiKey: "offline-synthetic",
      maxRetries: 0,
      fetch: (async () => {
        requests.push({ afterRefusal: refused });
        return Response.json({
          id: "synthetic",
          object: "chat.completion",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }) as unknown as typeof fetch,
    });
    const client = new Solwyn(raw, {
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      project: TEST_PROJECT,
      logger: noopLogger,
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      fetch: async (url) => {
        if (new URL(url).pathname !== AUTH_KEY_PATH) {
          return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
        }
        auths += 1;
        return auths === 1 ? authKeyResponse() : authKeyResponse({ scope: "read_only" });
      },
    });
    closers.push(() => client.close());
    await client.validate();
    // biome-ignore lint/suspicious/noExplicitAny: the probe drives native client shapes.
    const derived: any =
      mode === "raw-post-deferred-control" ? client : client.withOptions({ timeout: 1000 });
    // biome-ignore lint/suspicious/noExplicitAny: native APIPromise.
    let handle: any;
    if (mode !== "derived-namespace-after-refusal") {
      derived.prepareOptions = async () => {
        prepared.resolve();
        await release.promise;
      };
      handle =
        mode === "raw-post-deferred-control"
          ? derived.post("/chat/completions", { body: { model: "synthetic", messages: [] } })
          : derived.batches.create({
              input_file_id: "file-synthetic",
              endpoint: "/v1/chat/completions",
              completion_window: "24h",
            });
      await prepared.promise;
    }
    expect(await rejection(client.validate())).toBeInstanceOf(ApiKeyRefusedError);
    refused = true;
    release.resolve();
    const outcome = await rejection(
      Promise.resolve().then(() =>
        mode === "derived-namespace-after-refusal"
          ? derived.chat.completions.create({ model: "synthetic", messages: [] })
          : handle.withResponse(),
      ),
    );
    expect(outcome).toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests.filter((request) => request.afterRefusal)).toEqual([]);
  });
});

describe("review 4.3: fulfilled values stay fenced", () => {
  it.each([
    "await",
    "then-chain",
  ] as const)("a Google Live session obtained by %s never sends after a refusal", async (consumption) => {
    let auths = 0;
    let refused = false;
    const sends: Array<{ afterRefusal: boolean }> = [];
    const raw = new GoogleGenAI({ apiKey: "offline-synthetic" });
    (raw.live as unknown as { webSocketFactory: unknown }).webSocketFactory = {
      create(
        _url: unknown,
        _headers: unknown,
        callbacks: Record<string, (event?: unknown) => void>,
      ) {
        let first = true;
        return {
          connect() {
            queueMicrotask(() => callbacks["onopen"]?.());
          },
          send(_data: string) {
            sends.push({ afterRefusal: refused });
            if (first) {
              first = false;
              queueMicrotask(() =>
                callbacks["onmessage"]?.({ data: JSON.stringify({ setupComplete: {} }) }),
              );
            }
          },
          close() {},
        };
      },
    };
    const client = new Solwyn(raw, {
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      project: TEST_PROJECT,
      logger: noopLogger,
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      fetch: async (url) => {
        if (new URL(url).pathname !== AUTH_KEY_PATH) {
          return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
        }
        auths += 1;
        return auths === 1 ? authKeyResponse() : authKeyResponse({ scope: "read_only" });
      },
    });
    closers.push(() => client.close());
    await client.validate();
    const pending = client.live.connect({
      model: "gemini-live-synthetic",
      callbacks: { onmessage() {} },
    });
    const handle =
      consumption === "await"
        ? await pending
        : await pending.then((value) => value).then((value) => value);
    expect(await rejection(client.validate())).toBeInstanceOf(ApiKeyRefusedError);
    refused = true;
    expect(() => handle.sendClientContent({ turns: "synthetic", turnComplete: true })).toThrow(
      ApiKeyRefusedError,
    );
    expect(sends.filter((send) => send.afterRefusal)).toEqual([]);
  });

  it("a promised continuation iterator never opens another request after a refusal", async () => {
    let auths = 0;
    let refused = false;
    const requests: Array<{ afterRefusal: boolean }> = [];
    const raw = new GoogleGenAI({
      apiKey: "offline-synthetic",
      httpOptions: {
        fetch: async () => {
          requests.push({ afterRefusal: refused });
          const candidate: Record<string, unknown> = {
            content: { role: "model", parts: [{ text: "synthetic" }] },
            finishReason: requests.length === 1 ? "CONTINUATION" : "STOP",
          };
          if (requests.length === 1) candidate["continuationToken"] = "synthetic-checkpoint";
          const chunk = {
            candidates: [candidate],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      } as never,
    });
    const client = new Solwyn(raw, {
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      project: TEST_PROJECT,
      logger: noopLogger,
      leaseEnabled: false,
      reportUntrackedSurfaces: false,
      fetch: async (url) => {
        if (new URL(url).pathname !== AUTH_KEY_PATH) {
          return Response.json({ ingested: 0, rejected: [], duplicates: [] }, { status: 202 });
        }
        auths += 1;
        return auths === 1 ? authKeyResponse() : authKeyResponse({ scope: "read_only" });
      },
    });
    closers.push(() => client.close());
    await client.validate();
    const models = client.models as unknown as {
      generateContentStreamWithContinuation(params: unknown): Promise<AsyncIterable<unknown>>;
    };
    const stream = await models.generateContentStreamWithContinuation({
      model: "gemini-synthetic",
      contents: "synthetic",
    });
    expect(await rejection(client.validate())).toBeInstanceOf(ApiKeyRefusedError);
    refused = true;
    const outcome = await rejection(
      (async () => {
        let chunks = 0;
        for await (const _chunk of stream) {
          chunks += 1;
          if (chunks > 2) throw new Error("unexpected extra continuation");
        }
      })(),
    );
    expect(outcome).toBeInstanceOf(ApiKeyRefusedError);
    expect(requests.filter((request) => request.afterRefusal)).toEqual([]);
  });
});

describe("review 4.6 and retry cadence while refused", () => {
  it.each([
    "read_only_200",
    "expired_401",
  ] as const)("a revalidation answered with a refusal (%s) backs off 60 s", async (refusal) => {
    let now = 0;
    let auths = 0;
    const binding = testBinding({
      now: () => now,
      fetch: async () => {
        auths += 1;
        return refusal === "read_only_200"
          ? authKeyResponse({ scope: "read_only" })
          : expired("hard_deny");
      },
    });
    await rejection(binding.validate());
    now = 60_000;
    for (let call = 0; call < 5; call++) await rejection(binding.gate());
    expect(auths).toBe(2);
  });

  it("while refused, an unreachable key check retries after 5 s (single-flight), not 60 s", async () => {
    let now = 0;
    let auths = 0;
    let reachable = true;
    const binding = testBinding({
      now: () => now,
      fetch: async () => {
        auths += 1;
        if (!reachable) throw new TypeError("fetch failed");
        return expired("hard_deny");
      },
    });
    await rejection(binding.validate());
    expect(binding.state).toBe("refused");
    reachable = false;
    now = 60_000;
    await rejection(binding.gate());
    expect(auths).toBe(2);
    // Unreachable: 5 s, not 60 s, and at most one key check per window however many calls.
    for (let call = 0; call < 5; call++) await rejection(binding.gate());
    now += 4_999;
    await Promise.all([rejection(binding.gate()), rejection(binding.gate())]);
    expect(auths).toBe(2);
    now += 1;
    await Promise.all([rejection(binding.gate()), rejection(binding.gate())]);
    expect(auths).toBe(3);
    // Solwyn answers again with a refusal: back to the 60 s back-off.
    reachable = true;
    now += 5_000;
    await rejection(binding.gate());
    expect(auths).toBe(4);
    now += 59_999;
    await rejection(binding.gate());
    expect(auths).toBe(4);
  });
});
