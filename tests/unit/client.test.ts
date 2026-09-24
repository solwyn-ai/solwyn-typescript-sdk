/**
 * Exercises `Solwyn` client wrapping/passthrough, usage extraction wiring into the metadata
 * event, rich
 * TokenDetails propagation (no cost field), `call_id` reconciliation across events,
 * the estimate-missing-usage overwrite and zero-content guard, streaming settlement
 * (one event at stream end, aggregated usage, service tier), error-event reporting,
 * `responses.create` interception, and lifecycle (`close()` / `Symbol.asyncDispose`).
 *
 * Budget enforcement and failover are exercised in their dedicated integration tests.
 * Fully offline; the reporter's `fetch` is mocked to capture bodies.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, budgetCheckResult } from "../../src/budget";
import { materializeVelocityFlags } from "../../src/client";
import { ConfigurationError, RunStoppedError } from "../../src/errors";
import { type SelectionPolicy, Solwyn, type SolwynOptions } from "../../src/index";
import { currentRun, run } from "../../src/node";
import { __resetAdapterRegistry, __setAdapterLoadersForTesting } from "../../src/providers/index";
import type {
  CreateStreamAccumulatorOptions,
  Dialect,
  EstimateMissingUsageOptions,
  PrepareCallOptions,
  PreparedDispatch,
  ProviderAdapter,
  StreamUsageAccumulator,
} from "../../src/providers/protocol";
import { MetadataReporter } from "../../src/reporter";
import {
  clearRunTermination,
  markTerminated,
  postcheckTermination,
  resetRunControlForTest,
} from "../../src/run-control";
import { createTokenDetails, type TokenDetails, zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, VelocityFlag } from "../../src/types";
import { VelocityMonitor } from "../../src/velocity";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

// ---------------------------------------------------------------------------
// Fetch capture + fake-client helpers.
// ---------------------------------------------------------------------------

/** The serialized (wire) metadata event shape — no index signature (dot access). */
interface WireEvent {
  status: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  is_model_fallback: boolean;
  is_provider_fallback: boolean;
  attempt_index: number;
  call_id: string;
  sdk_instance_id: string;
  timestamp: string;
  service_tier?: string;
  failover_error_class?: string;
  possibly_succeeded?: boolean;
  provider_region?: string;
  token_details?: TokenDetails;
  agent_run_id?: string;
  agent_run_name?: string;
  parent_agent_run_id?: string;
  tags?: Record<string, string>;
  deny_source?: string;
  deny_reason?: string;
  denied_by_period?: string;
  estimated_output_bound?: number;
  velocity_flags?: VelocityFlag[];
}

/** Resolve after `ms` real milliseconds (used to make latency measurably non-zero). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFetch(): {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  ingested: WireEvent[];
  confirms: Array<Record<string, unknown>>;
} {
  const ingested: WireEvent[] = [];
  const confirms: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      // A VALID allow response with NO reservation id (mirrors budget-integration.test.ts's
      // allow() helper). Routing this correctly keeps the client tests on the real allow
      // pipeline instead of silently entering the budget-outage fail-open branch;
      // reservation_id is null, so the reservation-less path skips confirmation and
      // the "no confirm expected" assertions below keep holding.
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: null,
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
      ingested.push(...(raw as WireEvent[]));
    }
    if (url.includes("/api/v1/budgets/confirm") && raw !== undefined) {
      confirms.push(raw as Record<string, unknown>);
    }
    // Valid ingest 202 body (never the malformed `[]`): the default logger is now
    // console-backed, so a malformed body would print an unparseable warning.
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), ingested, confirms };
}

function stoppedRunFetch(): {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  ingested: WireEvent[];
} {
  const ingested: WireEvent[] = [];
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      return new Response(
        JSON.stringify({
          allowed: false,
          remaining_budget: 0,
          reservation_id: null,
          mode: "hard_deny",
          budget_limit: 100,
          current_usage: 100,
          denied_by_period: "run_stopped",
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
      ingested.push(...(raw as WireEvent[]));
    }
    return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), ingested };
}

/** A minimal OpenAI-shaped client whose `chat.completions.create` is a `(kwargs) => …` spy. */
function openAIClient(impl: (kwargs: Record<string, unknown>) => unknown) {
  const create = vi.fn((kwargs: Record<string, unknown>) => impl(kwargs));
  return { chat: { completions: { create } } };
}

function expectReservedTagRecord(
  value: unknown,
  protoValue: string,
  constructorValue: string,
): void {
  if (value === null || typeof value !== "object") {
    throw new Error("expected a tag record");
  }
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.hasOwn(value, "__proto__")).toBe(true);
  expect(Reflect.get(value, "__proto__")).toBe(protoValue);
  expect(Object.hasOwn(value, "constructor")).toBe(true);
  expect(Reflect.get(value, "constructor")).toBe(constructorValue);
}

// ---------------------------------------------------------------------------
// Basic wrapping / passthrough.
// ---------------------------------------------------------------------------

describe("SolwynCore — basic wrapping", () => {
  it("admits and validates the reporter reliability option surface", async () => {
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(
      openAIClient(() => ({})),
      {
        apiKey: API_KEY,
        fetch: fetchMock,
        reporterMaxSendAttempts: 7,
        reporterRetryBackoffBase: 0.25,
        reporterRetryBackoffCap: 12,
        reporterShutdownDeadline: 0,
        breakerReportHeartbeat: 15,
        leaseEnabled: false,
        leaseOutputBoundDefault: 2048,
      },
    );

    await expect(solwyn.close()).resolves.toBeUndefined();
  });

  it("routes chat.completions.create through the wrapped client and returns its response unchanged", async () => {
    const response = { id: "resp", usage: { prompt_tokens: 1, completion_tokens: 2 } };
    const client = openAIClient(() => response);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const result = await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(result).toBe(response);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("passes non-intercepted top-level attributes straight through to the wrapped client", async () => {
    const models = { list: () => "MODELS" };
    const client = { chat: { completions: { create: () => ({}) } }, models, apiVersion: "v9" };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const passthrough = solwyn as unknown as { models: typeof models; apiVersion: string };
    expect(passthrough.models.list()).toBe("MODELS");
    expect(passthrough.apiVersion).toBe("v9");
    await solwyn.close();
  });
});

// ---------------------------------------------------------------------------
// Native primary request-bag hot path.
// ---------------------------------------------------------------------------

describe("SolwynCore — native primary request bags", () => {
  it("passes a fresh shallow primary bag, preserves nested identities, and fills the configured model", async () => {
    let dispatched: Record<string, unknown> | undefined;
    const client = openAIClient((kwargs) => {
      dispatched = kwargs;
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const { fetchMock } = makeFetch();
    const messages: unknown[] = [];
    const metadata = { trace: "trace-1" };
    const caller: Record<string, unknown> = { messages, metadata };
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      model: "configured-model",
    });

    await solwyn.chat.completions.create(caller);

    expect(dispatched).toMatchObject({ model: "configured-model", messages, metadata });
    expect(dispatched).not.toBe(caller);
    expect(dispatched?.["messages"]).toBe(messages);
    expect(dispatched?.["metadata"]).toBe(metadata);
    expect(caller).toEqual({ messages, metadata });
    await solwyn.close();
  });

  it("copies hostile own keys, symbols, and getters into the provider bag without mutating either prototype", async () => {
    let dispatched: Record<PropertyKey, unknown> | undefined;
    const client = openAIClient((kwargs) => {
      dispatched = kwargs;
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const { fetchMock, ingested } = makeFetch();
    const protoValue = { exact: "own-data-value" };
    const symbolKey = Symbol("caller-symbol");
    const symbolValue = { preserved: true };
    const ordinaryValue = { shallow: "copy" };
    let ordinaryReads = 0;
    let tagReads = 0;
    const caller: Record<PropertyKey, unknown> = { model: "gpt-4o", messages: [] };
    Object.defineProperty(caller, "__proto__", {
      value: protoValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperties(caller, {
      ordinary: {
        get: () => {
          ordinaryReads += 1;
          return ordinaryValue;
        },
        enumerable: true,
        configurable: true,
      },
      solwyn_tags: {
        get: () => {
          tagReads += 1;
          return { customer: "acme" };
        },
        enumerable: true,
        configurable: true,
      },
      [symbolKey]: {
        value: symbolValue,
        enumerable: true,
        configurable: true,
        writable: true,
      },
    });
    const sourceProto = Object.getPrototypeOf(caller);
    const sourceProtoDescriptor = Object.getOwnPropertyDescriptor(caller, "__proto__");
    const sourceOrdinaryDescriptor = Object.getOwnPropertyDescriptor(caller, "ordinary");
    const sourceTagDescriptor = Object.getOwnPropertyDescriptor(caller, "solwyn_tags");
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create(caller as Record<string, unknown>);
    await solwyn.close();

    const providerKwargs = dispatched as Record<PropertyKey, unknown>;
    const providerProtoDescriptor = Object.getOwnPropertyDescriptor(providerKwargs, "__proto__");
    const providerOrdinaryDescriptor = Object.getOwnPropertyDescriptor(providerKwargs, "ordinary");
    expect(Object.getPrototypeOf(caller)).toBe(sourceProto);
    expect(Object.getPrototypeOf(providerKwargs)).toBe(Object.prototype);
    expect(sourceProtoDescriptor?.value).toBe(protoValue);
    expect(providerProtoDescriptor?.value).toBe(protoValue);
    expect(providerProtoDescriptor?.get).toBeUndefined();
    expect(providerOrdinaryDescriptor?.value).toBe(ordinaryValue);
    expect(providerOrdinaryDescriptor?.get).toBeUndefined();
    expect(providerKwargs[symbolKey]).toBe(symbolValue);
    expect(providerKwargs).not.toHaveProperty("solwyn_tags");
    expect(ordinaryReads).toBe(1);
    expect(tagReads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(caller, "ordinary")).toEqual(sourceOrdinaryDescriptor);
    expect(Object.getOwnPropertyDescriptor(caller, "solwyn_tags")).toEqual(sourceTagDescriptor);
    expect(Object.prototype).not.toHaveProperty("exact");
    expect(ingested[0]?.tags).toEqual({ customer: "acme" });
  });

  it("warns about merged-tag clamping once per client and logs later clamps at debug level", async () => {
    const tags = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`default-${index}`, `value-${index}`]),
    );
    const makeClient = () => ({
      chat: {
        completions: {
          create: vi.fn((_kwargs: Record<string, unknown>) => ({
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })),
        },
      },
    });
    const makeLogger = () => ({
      debug: vi.fn<(message: string) => void>(),
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    });
    const clampMessages = (mock: ReturnType<typeof makeLogger>["warn"]) =>
      mock.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith("merged tags exceed 10 keys"));
    const { fetchMock, ingested } = makeFetch();
    const firstLogger = makeLogger();
    const secondLogger = makeLogger();
    const first = new Solwyn(makeClient(), {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: firstLogger,
      tags,
    });
    const second = new Solwyn(makeClient(), {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: secondLogger,
      tags,
    });
    const request = () => ({
      model: "gpt-4o",
      messages: [],
      solwyn_tags: { caller: "overflow" },
    });

    for (let index = 0; index < 200; index += 1) {
      await first.chat.completions.create(request());
    }
    await second.chat.completions.create(request());
    await first.close();
    await second.close();

    expect(clampMessages(firstLogger.warn)).toEqual([
      "merged tags exceed 10 keys; lower-priority tags were dropped (further occurrences on this client are logged at debug level)",
    ]);
    const firstDebug = clampMessages(firstLogger.debug);
    expect(firstDebug).toHaveLength(199);
    expect(firstDebug.at(-1)).toBe(
      "merged tags exceed 10 keys; lower-priority tags were dropped (occurrence 200 on this client)",
    );
    // The latch is per client: another client's first clamp still warns.
    expect(clampMessages(secondLogger.warn)).toHaveLength(1);
    expect(clampMessages(secondLogger.debug)).toHaveLength(0);
    // Clamping itself is unchanged on every call: the per-call tag wins and one default drops.
    expect(ingested).toHaveLength(201);
    for (const event of ingested) {
      expect(Object.keys(event.tags ?? {})).toHaveLength(10);
      expect(event.tags?.["caller"]).toBe("overflow");
    }
  });

  it("dispatches a no-default native primary without enumerating empty default records", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const client = { chat: { completions: { create } } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    // A regression to Object.keys(defaults) here allocates before the one defensive request copy.
    const realObjectKeys = Object.keys;
    const objectKeys = vi.spyOn(Object, "keys").mockImplementation((value) => {
      if (new Error().stack?.includes("SolwynCore.#prepareHopKwargs")) {
        throw new Error("native no-default dispatch must not enumerate default records");
      }
      return realObjectKeys(value);
    });

    try {
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    } finally {
      objectKeys.mockRestore();
      await solwyn.close();
    }

    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps the one-copy no-default path primary-only and free of default-record scans", () => {
    const source = readFileSync(new URL("../../src/client.ts", import.meta.url), "utf8");
    const methodStart = source.indexOf("  #prepareHopKwargs(");
    const nativeStart = source.indexOf("    if (!endpointTransition)", methodStart);
    const crossProviderStart = source.indexOf("    // CROSS-PROVIDER hop.", nativeStart);
    const nativePath = source.slice(nativeStart, crossProviderStart);
    const fastBranch = nativePath.match(
      /if \(\s*runtime === ctx\.primary &&[\s\S]*?return \{ \.\.\.ctx\.callerKwargs, model: hop\.model \};\s*\}/,
    );

    // Real dispatch above pins observable copy/model semantics. This narrow source invariant pins
    // the allocation-only distinction: global emptiness must be precomputed and only the primary
    // runtime may bypass the authoritative layered spread.
    expect(fastBranch).not.toBeNull();
    expect(fastBranch?.[0]).toContain("this.#hasNoGlobalDefaultParams");
    expect(fastBranch?.[0]).not.toMatch(
      /globalDefaults|entryDefaults|hasOwnEnumerableKey|Object\.keys|Reflect\.ownKeys/,
    );
  });

  it("preserves enumerable symbol defaults on a same-provider model fallback", async () => {
    const primaryError = Object.assign(new Error("primary unavailable"), { status: 429 });
    let primaryKwargs: Record<string, unknown> | undefined;
    const primary = openAIClient((kwargs) => {
      primaryKwargs = kwargs;
      throw primaryError;
    });
    let fallbackKwargs: Record<PropertyKey, unknown> | undefined;
    const fallback = openAIClient((kwargs) => {
      fallbackKwargs = kwargs;
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const fallbackDefaultKey = Symbol("fallback-default");
    const fallbackDefaultValue = { preserved: true };
    const fallbackDefaults = {
      [fallbackDefaultKey]: fallbackDefaultValue,
      fallback: "kept",
      solwyn_tags: { entry: "fallback" },
    };
    const defaults = { global: "kept", solwyn_tags: { global: "default" } };
    const caller = {
      model: "primary-model",
      messages: [],
      unrelated: "caller",
      solwyn_tags: { caller: "call" },
    };
    const defaultsBefore = { ...defaults, solwyn_tags: { ...defaults.solwyn_tags } };
    const fallbackDefaultsBefore = {
      ...fallbackDefaults,
      solwyn_tags: { ...fallbackDefaults.solwyn_tags },
    };
    const callerBefore = { ...caller, solwyn_tags: { ...caller.solwyn_tags } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
      defaultParams: defaults,
      fallback: [[fallback, "fallback-model", fallbackDefaults, "openai"]],
    });

    await solwyn.chat.completions.create(caller);

    expect(primaryKwargs).toEqual({
      global: "kept",
      model: "primary-model",
      messages: caller.messages,
      unrelated: "caller",
    });
    expect(primaryKwargs).not.toHaveProperty("solwyn_tags");
    expect(fallback.chat.completions.create).toHaveBeenCalledOnce();
    expect(fallbackKwargs).not.toHaveProperty("solwyn_tags");
    expect(defaults).toEqual(defaultsBefore);
    expect(fallbackDefaults).toEqual(fallbackDefaultsBefore);
    expect(caller).toEqual(callerBefore);
    expect(fallbackKwargs).toEqual({
      [fallbackDefaultKey]: fallbackDefaultValue,
      global: "kept",
      fallback: "kept",
      model: "fallback-model",
      messages: caller.messages,
      unrelated: "caller",
    });
    await solwyn.close();
  });

  it("strips tags while preserving unrelated keys on a same-dialect cross-provider fallback", async () => {
    const primaryError = Object.assign(new Error("primary unavailable"), { status: 429 });
    let primaryKwargs: Record<string, unknown> | undefined;
    const primary = openAIClient((kwargs) => {
      primaryKwargs = kwargs;
      throw primaryError;
    });
    let fallbackKwargs: Record<string, unknown> | undefined;
    const fallback = {
      ...openAIClient((kwargs) => {
        fallbackKwargs = kwargs;
        return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
      }),
      baseURL: "https://api.deepseek.com/v1",
    };
    const fallbackDefaults = {
      target_unrelated: "target-default",
      solwyn_tags: { entry: "fallback" },
    };
    const defaults = {
      global_unrelated: "global-default",
      solwyn_tags: { global: "default" },
    };
    const caller = {
      model: "primary-model",
      messages: [],
      caller_unrelated: "caller",
      solwyn_tags: { caller: "call" },
    };
    const defaultsBefore = { ...defaults, solwyn_tags: { ...defaults.solwyn_tags } };
    const fallbackDefaultsBefore = {
      ...fallbackDefaults,
      solwyn_tags: { ...fallbackDefaults.solwyn_tags },
    };
    const callerBefore = { ...caller, solwyn_tags: { ...caller.solwyn_tags } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
      defaultParams: defaults,
      fallback: [[fallback, "fallback-model", fallbackDefaults, "deepseek"]],
    });

    await solwyn.chat.completions.create(caller);

    expect(primaryKwargs).toEqual({
      global_unrelated: "global-default",
      model: "primary-model",
      messages: caller.messages,
      caller_unrelated: "caller",
    });
    expect(primaryKwargs).not.toHaveProperty("solwyn_tags");
    expect(fallback.chat.completions.create).toHaveBeenCalledOnce();
    expect(fallbackKwargs).toEqual({
      global_unrelated: "global-default",
      target_unrelated: "target-default",
      model: "fallback-model",
      messages: caller.messages,
      caller_unrelated: "caller",
    });
    expect(fallbackKwargs).not.toHaveProperty("solwyn_tags");
    expect(defaults).toEqual(defaultsBefore);
    expect(fallbackDefaults).toEqual(fallbackDefaultsBefore);
    expect(caller).toEqual(callerBefore);
    await solwyn.close();
  });

  it("retains global defaults on the native primary branch", async () => {
    let dispatched: Record<string, unknown> | undefined;
    const client = openAIClient((kwargs) => {
      dispatched = kwargs;
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      defaultParams: { temperature: 0.2 },
    });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });

    expect(dispatched).toMatchObject({ model: "gpt-4o", temperature: 0.2 });
    await solwyn.close();
  });

  it("retains OpenAI completion-cap normalization on the native primary branch", async () => {
    let dispatched: Record<string, unknown> | undefined;
    const client = openAIClient((kwargs) => {
      dispatched = kwargs;
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({
      model: "o3-mini",
      messages: [],
      max_tokens: 7,
    });

    expect(dispatched).toMatchObject({ model: "o3-mini", max_completion_tokens: 7 });
    expect(dispatched).not.toHaveProperty("max_tokens");
    await solwyn.close();
  });
});

// ---------------------------------------------------------------------------
// Usage extraction -> metadata event.
// ---------------------------------------------------------------------------

describe("SolwynCore — usage extraction wiring", () => {
  it("builds one success event with extracted tokens, provider, service tier, ids, timestamp", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      service_tier: "priority",
    }));
    const { fetchMock, ingested, confirms } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
    await solwyn.close();

    expect(ingested).toHaveLength(1);
    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("success");
    expect(event.provider).toBe("openai");
    expect(event.model).toBe("gpt-4o");
    expect(event.input_tokens).toBe(10);
    expect(event.output_tokens).toBe(20);
    expect(event.service_tier).toBe("priority");
    expect(event.is_model_fallback).toBe(false);
    expect(event.is_provider_fallback).toBe(false);
    expect(event.attempt_index).toBe(0);
    expect(typeof event.call_id).toBe("string");
    expect((event.call_id as string).length).toBeLessThanOrEqual(36);
    expect(typeof event.sdk_instance_id).toBe("string");
    expect(typeof event.timestamp).toBe("string");
    // The check allow carries no reservation_id, so the reservation-less path skips
    // confirmation entirely, so no confirmation request is sent.
    expect(confirms).toHaveLength(0);
  });

  it("propagates the full rich TokenDetails breakdown and never emits a cost field", async () => {
    const client = openAIClient(() => ({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 40, audio_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    const details = (ingested[0] as WireEvent).token_details as TokenDetails;
    expect(details.input_tokens).toBe(100);
    expect(details.output_tokens).toBe(50);
    expect(details.cached_input_tokens).toBe(40);
    expect(details.audio_input_tokens).toBe(5);
    expect(details.reasoning_tokens).toBe(12);
    // No cost/price field anywhere in the wire event.
    const flat = JSON.stringify(ingested[0]);
    expect(flat).not.toContain("cost");
    expect(flat).not.toContain("price");
  });

  it("keys the served metadata off the per-call model, overriding the constructor model", async () => {
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, model: "gpt-4o-mini", fetch: fetchMock });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect((ingested[0] as WireEvent).model).toBe("gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// call_id reconciliation.
// ---------------------------------------------------------------------------

describe("SolwynCore — call_id reconciliation", () => {
  it("mints one call_id per call; two separate calls get distinct ids", async () => {
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(ingested).toHaveLength(2);
    expect(ingested[0]?.call_id).not.toBe(ingested[1]?.call_id);
  });

  it("gives concurrently-interleaved calls non-cross-contaminated call_ids", async () => {
    const client = openAIClient(async () => {
      await new Promise((r) => setTimeout(r, 3));
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await Promise.all([
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ]);
    await solwyn.close();

    const ids = new Set(ingested.map((e) => e.call_id));
    expect(ids.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Streaming settlement.
// ---------------------------------------------------------------------------

async function* fakeStream(): AsyncGenerator<unknown> {
  yield { choices: [{ delta: { content: "he" } }] };
  yield { choices: [{ delta: { content: "llo" } }] };
  yield {
    choices: [{ delta: {} }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
    service_tier: "flex",
  };
}

describe("SolwynCore — streaming settlement", () => {
  it("returns a stream wrapper, injects include_usage, and settles ONE event after exhaustion", async () => {
    const client = openAIClient(() => fakeStream());
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;

    // include_usage is injected onto the kwargs the SDK actually receives.
    const passedKwargs = client.chat.completions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(passedKwargs["stream"]).toBe(true);
    expect(passedKwargs["stream_options"]).toEqual({ include_usage: true });

    const collected: unknown[] = [];
    for await (const chunk of stream) {
      collected.push(chunk);
    }
    await solwyn.close();

    // Chunks pass through unchanged, in order.
    expect(collected).toHaveLength(3);
    expect((collected[0] as { choices: unknown }).choices).toBeDefined();
    // Exactly one settlement event, with aggregated usage + terminal service tier.
    expect(ingested).toHaveLength(1);
    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("success");
    expect(event.input_tokens).toBe(5);
    expect(event.output_tokens).toBe(7);
    expect(event.service_tier).toBe("flex");
  });

  it("does not report before the stream is drained (settlement is at stream end)", async () => {
    const client = openAIClient(() => fakeStream());
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    // Obtain the stream but never drain it; the client shuts down without a settlement.
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
    await solwyn.close();

    expect(ingested).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error-event reporting.
// ---------------------------------------------------------------------------

class ProviderBoom extends Error {
  constructor() {
    super("upstream 500");
    this.name = "ProviderBoom";
  }
}

describe("SolwynCore — error reporting", () => {
  it("reports a status=error event (class name only, zeroed tokens) and re-raises the original error", async () => {
    const boom = new ProviderBoom();
    const client = openAIClient(() => {
      throw boom;
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      tags: { environment: "test" },
    });

    await expect(
      solwyn.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        solwyn_tags: { customer: "acme" },
      }),
    ).rejects.toBe(boom);
    await solwyn.close();

    expect(ingested).toHaveLength(1);
    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("error");
    expect(event.input_tokens).toBe(0);
    expect(event.output_tokens).toBe(0);
    expect(event.failover_error_class).toBe("ProviderBoom");
    expect(event.tags).toEqual({ customer: "acme", environment: "test" });
    expect("token_details" in event).toBe(false);
    // The privacy-sensitive message never rides on the wire.
    expect(JSON.stringify(event)).not.toContain("upstream 500");
  });

  it("omits a constructor-shaped class label from a non-Error throw and rethrows it unchanged", async () => {
    const forged = { constructor: { name: "SecretToken" } };
    const client = openAIClient(() => {
      throw forged;
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
      forged,
    );
    await solwyn.close();

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.status).toBe("error");
    expect(ingested[0]?.failover_error_class).toBeUndefined();
  });
});

describe("SolwynCore — text-call tags", () => {
  it("captures unscoped call and configured tags for budget and success telemetry without forwarding them", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const client = { chat: { completions: { create } } };
    const defaults = { temperature: 0.2, solwyn_tags: { ignored: "default" } };
    const caller = { model: "gpt-4o", messages: [], solwyn_tags: { customer: "acme" } };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      defaultParams: defaults,
      tags: { environment: "test" },
    });

    await solwyn.chat.completions.create(caller);
    await solwyn.close();

    const check = fetchMock.mock.calls
      .map(([, init]) => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined))
      .find((body) => body?.tags !== undefined) as Record<string, unknown>;
    expect(check).toMatchObject({ tags: { customer: "acme", environment: "test" } });
    expect(ingested[0]).toMatchObject({ tags: { customer: "acme", environment: "test" } });
    expect(ingested[0]).not.toHaveProperty("agent_run_id");
    expect(create).toHaveBeenCalledWith(
      { model: "gpt-4o", messages: [], temperature: 0.2 },
      { timeout: 600_000, maxRetries: 0 },
    );
    expect(caller).toEqual({ model: "gpt-4o", messages: [], solwyn_tags: { customer: "acme" } });
    expect(defaults).toEqual({ temperature: 0.2, solwyn_tags: { ignored: "default" } });
  });

  it.each([
    "constructor-default",
    "run-scope",
    "per-call",
  ] as const)("preserves own reserved-looking tags from the %s source through checks and metadata", async (source) => {
    const protoValue = `${source}-admin`;
    const constructorValue = `${source}-safe`;
    const tags = Object.fromEntries([
      ["__proto__", protoValue],
      ["constructor", constructorValue],
    ]);
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      {
        apiKey: API_KEY,
        fetch: fetchMock,
        ...(source === "constructor-default" ? { tags } : {}),
      },
    );
    const caller: Record<string, unknown> = { model: "gpt-4o", messages: [] };
    if (source === "per-call") {
      Object.defineProperty(caller, "solwyn_tags", {
        value: tags,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    if (source === "run-scope") {
      await run("reserved-tag-run", { tags }, () => solwyn.chat.completions.create(caller));
    } else {
      await solwyn.chat.completions.create(caller);
    }
    await solwyn.close();

    const checkCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/v1/budgets/check"),
    );
    expect(checkCall).toBeDefined();
    const check = JSON.parse(String(checkCall?.[1]?.body)) as Record<string, unknown>;
    expectReservedTagRecord(Reflect.get(check, "tags"), protoValue, constructorValue);
    expect(ingested).toHaveLength(1);
    expectReservedTagRecord(ingested[0]?.tags, protoValue, constructorValue);
    const providerKwargs = create.mock.calls[0]?.[0];
    expect(providerKwargs).toBeDefined();
    expect(Object.hasOwn(providerKwargs as object, "solwyn_tags")).toBe(false);
    expectReservedTagRecord(tags, protoValue, constructorValue);
  });

  it("rejects malformed per-call tags before budget or provider I/O", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({}));
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      { apiKey: API_KEY, fetch: fetchMock },
    );

    await expect(
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [], solwyn_tags: "bad" }),
    ).rejects.toThrow(/solwyn_tags requires a plain record/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("captures an own non-enumerable tag statement without changing its descriptor", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock, ingested } = makeFetch();
    const caller: Record<string, unknown> = { model: "gpt-4o", messages: [] };
    Object.defineProperty(caller, "solwyn_tags", {
      value: { customer: "acme" },
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(caller, "solwyn_tags");
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      { apiKey: API_KEY, fetch: fetchMock },
    );

    await solwyn.chat.completions.create(caller);
    await solwyn.close();

    const check = fetchMock.mock.calls
      .map(([, init]) => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined))
      .find((body) => body?.provider === "openai") as Record<string, unknown>;
    expect(check["tags"]).toEqual({ customer: "acme" });
    expect(ingested[0]?.tags).toEqual({ customer: "acme" });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
    expect(Object.getOwnPropertyDescriptor(caller, "solwyn_tags")).toEqual(descriptor);
  });

  it("rejects an invalid own non-enumerable tag statement before I/O", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({}));
    const { fetchMock } = makeFetch();
    const caller: Record<string, unknown> = { model: "gpt-4o", messages: [] };
    Object.defineProperty(caller, "solwyn_tags", { value: "invalid", enumerable: false });
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      { apiKey: API_KEY, fetch: fetchMock },
    );

    await expect(solwyn.chat.completions.create(caller)).rejects.toThrow(/solwyn_tags/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("omits empty captured tag layers from budget and telemetry", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      { apiKey: API_KEY, fetch: fetchMock, tags: {} },
    );

    await run("empty-tags", { tags: {} }, () =>
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [], solwyn_tags: {} }),
    );
    await solwyn.close();

    const check = fetchMock.mock.calls
      .map(([, init]) => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined))
      .find((body) => body?.provider === "openai") as Record<string, unknown>;
    expect(check).not.toHaveProperty("tags");
    expect(ingested[0]).not.toHaveProperty("tags");
  });

  it("clamps per-call, run, and configured layers once without letting a throwing logger block dispatch", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const warn = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(
      { chat: { completions: { create } } },
      {
        apiKey: API_KEY,
        fetch: fetchMock,
        tags: {
          default0: "0",
          default1: "1",
          default2: "2",
          default3: "3",
          default4: "4",
          default5: "5",
          default6: "6",
          default7: "7",
          default8: "8",
          default9: "9",
        },
        logger: { debug() {}, info() {}, warn, error() {} },
      },
    );

    await run("tag-layer", { tags: { default0: "run", run: "scope" } }, async () => {
      await solwyn.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        solwyn_tags: { default0: "call", call: "override" },
      });
    });
    await solwyn.close();

    expect(warn).toHaveBeenCalledOnce();
    expect(ingested[0]?.tags).toEqual({
      default0: "call",
      call: "override",
      run: "scope",
      default1: "1",
      default2: "2",
      default3: "3",
      default4: "4",
      default5: "5",
      default6: "6",
      default7: "7",
    });
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("SolwynCore — stopped-run denial ordering", () => {
  it.each([
    ["buffered", {}],
    ["streaming", { stream: true }],
  ] as const)("reports then preserves the typed stopped error before %s dispatch", async (_surface, extra) => {
    const order: string[] = [];
    const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
    const client = openAIClient(() => {
      order.push("dispatch");
      return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
    const { fetchMock, ingested } = stoppedRunFetch();
    const originalReport = MetadataReporter.prototype.report;
    const report = vi.spyOn(MetadataReporter.prototype, "report").mockImplementation(function (
      this: MetadataReporter,
      event,
    ) {
      order.push("report");
      originalReport.call(this, event);
      throw new Error("report failure must not mask the stop");
    });
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      tags: { environment: "test" },
      logger: { debug() {}, info() {}, warn, error() {} },
    });

    let runId = "";
    let caught: unknown;
    try {
      await run(`core-stopped-${_surface}`, { tags: { scope: "run" } }, async () => {
        runId = currentRun()?.agentRunId ?? "";
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [], solwyn_tags: { customer: "acme" }, ...extra })
          .then(
            () => null,
            (error: unknown) => {
              order.push("error");
              return error;
            },
          );
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({ reason: "run_stopped", source: "server" });
    expect(order).toEqual(["report", "error"]);
    expect(warn).toHaveBeenCalledWith("Failed to report budget_denied metadata event: %s", "Error");
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      status: "budget_denied",
      provider: "openai",
      model: "gpt-4o",
      attempt_index: 0,
      input_tokens: 0,
      output_tokens: 0,
      is_model_fallback: false,
      is_provider_fallback: false,
      agent_run_id: runId,
      agent_run_name: `core-stopped-${_surface}`,
      deny_source: "server",
      deny_reason: "run_stopped",
      denied_by_period: "run_stopped",
      estimated_output_bound: 4096,
      tags: { customer: "acme", scope: "run", environment: "test" },
    });
    expect(ingested[0]).not.toHaveProperty("parent_agent_run_id");
    expect(ingested[0]).not.toHaveProperty("velocity_flags");
  });

  it("keeps an unscoped run_stopped verdict ordinary and never formats Run None", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock, ingested } = stoppedRunFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
      tags: { environment: "test" },
    });

    const caught = await solwyn.chat.completions
      .create({ model: "gpt-4o", messages: [] })
      .catch((error: unknown) => error);
    await solwyn.close();

    expect(caught).toMatchObject({ name: "BudgetExceededError", budgetPeriod: "run_stopped" });
    expect(caught).not.toBeInstanceOf(RunStoppedError);
    expect(String(caught)).not.toContain("Run None");
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).not.toHaveProperty("agent_run_id");
    expect(ingested[0]).not.toHaveProperty("agent_run_name");
  });
});

describe("SolwynCore — local run-control admission", () => {
  afterEach(() => {
    resetRunControlForTest();
    __resetAdapterRegistry();
    vi.restoreAllMocks();
  });

  it.each([
    ["buffered", {}],
    ["streaming", { stream: true }],
  ] as const)("pre-gates a retained local stop with the immutable nested-run receipt for %s calls", async (_surface, extra) => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock } = makeFetch();
    const reports: WireEvent[] = [];
    const report = vi
      .spyOn(MetadataReporter.prototype, "report")
      .mockImplementation((event) => reports.push(event as WireEvent));
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
    });

    let parentId = "";
    let childId = "";
    let caught: unknown;
    try {
      await run("parent-run", { tags: { team: "platform" } }, async () => {
        parentId = currentRun()?.agentRunId ?? "";
        await run("child-run", { tags: { task: "ten" } }, async () => {
          childId = currentRun()?.agentRunId ?? "";
          markTerminated(childId, { reason: "repeat_size", source: "local_velocity" });
          caught = await solwyn.chat.completions
            .create({
              model: "gpt-4o",
              messages: [],
              max_tokens: 200_000_001,
              solwyn_tags: { customer: "acme" },
              ...extra,
            })
            .catch((error: unknown) => error);
        });
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({
      agentRunId: childId,
      reason: "repeat_size",
      source: "local_velocity",
    });
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "budget_denied",
      provider: "openai",
      model: "gpt-4o",
      attempt_index: 0,
      input_tokens: 0,
      output_tokens: 0,
      agent_run_id: childId,
      agent_run_name: "child-run",
      parent_agent_run_id: parentId,
      tags: { customer: "acme", team: "platform", task: "ten" },
      deny_source: "run_terminated",
      deny_reason: "repeat_size",
      denied_by_period: "run_stopped",
      estimated_output_bound: 100_000_000,
    });
  });

  it("observes the exact chat velocity payload and pre-gates calls after the threshold", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock, ingested } = makeFetch();
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(12_345);
    const observe = vi.spyOn(VelocityMonitor.prototype, "observe");
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 2,
      velocityRepeatWindowS: 60,
    });

    const caught: unknown[] = [];
    let runId = "";
    let observations: unknown[][] = [];
    try {
      await run("velocity-run", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const request = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "abcdefgh" }],
        };
        await solwyn.chat.completions.create(request);
        for (let index = 0; index < 2; index += 1) {
          caught.push(
            await solwyn.chat.completions.create(request).catch((error: unknown) => error),
          );
        }
      });
      observations = observe.mock.calls;
    } finally {
      observe.mockRestore();
      monotonicNow.mockRestore();
      await solwyn.close();
    }

    const budgetChecks = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/budgets/check"),
    );
    expect(caught[0]).toBeInstanceOf(RunStoppedError);
    expect(caught[0]).toMatchObject({
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    expect(caught[1]).toMatchObject({
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(budgetChecks).toHaveLength(1);
    expect(observations).toEqual([
      [{ runId, estimatedInputTokens: 2, model: "gpt-4o", now: 12.345 }],
      [{ runId, estimatedInputTokens: 2, model: "gpt-4o", now: 12.345 }],
    ]);
    expect(
      ingested
        .filter((event) => event.status === "budget_denied")
        .map((event) => ({
          deny_source: event.deny_source,
          deny_reason: event.deny_reason,
          velocity_flags: event.velocity_flags,
        })),
    ).toEqual([
      {
        deny_source: "local_velocity",
        deny_reason: "velocity:repeat_size",
        velocity_flags: ["repeat_size"],
      },
      {
        deny_source: "run_terminated",
        deny_reason: "velocity:repeat_size",
        velocity_flags: undefined,
      },
    ]);
  });

  it("chooses monotonic growth ahead of repeat size when both deny rules fire", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 3,
      velocityGrowthStreak: 3,
      velocityGrowthFactor: 1.5,
    });

    let caught: unknown;
    try {
      await run("velocity-precedence", async () => {
        await solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "aaaa" }],
        });
        await solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "aaaaaaaa" }],
        });
        caught = await solwyn.chat.completions
          .create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "aaaaaaaaaaaa" }],
          })
          .catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(caught).toMatchObject({
      name: "RunStoppedError",
      reason: "velocity:monotonic_growth",
      source: "local_velocity",
    });
  });

  it("defers a local winner behind a cleared server stop, then releases funded work with a complete receipt", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock } = makeFetch();
    let checks = 0;
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockImplementation(async (request) => {
        checks += 1;
        if (checks === 2) {
          clearRunTermination(request.agentRunId ?? "");
          return budgetCheckResult({
            allowed: true,
            remainingBudget: 100,
            leaseId: "lease-deferred-local",
            leaseClaimToken: 71,
          });
        }
        return budgetCheckResult({ allowed: true, remainingBudget: 100 });
      });
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const reports: WireEvent[] = [];
    const report = vi
      .spyOn(MetadataReporter.prototype, "report")
      .mockImplementation((event) => reports.push(event as WireEvent));
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 2,
      velocityRepeatWindowS: 60,
    });

    let caught: unknown;
    try {
      await run("velocity-parent", { tags: { org: "sdk" } }, async () => {
        const parentId = currentRun()?.agentRunId ?? "";
        await run("velocity-server-order", { tags: { task: "ten" } }, async () => {
          const runId = currentRun()?.agentRunId ?? "";
          await solwyn.chat.completions.create({
            model: "gpt-4o",
            messages: [],
            max_tokens: 200_000_001,
          });
          markTerminated(runId, { reason: "stale_server_stop", source: "server" });
          caught = await solwyn.chat.completions
            .create({ model: "gpt-4o", messages: [], max_tokens: 200_000_001 })
            .catch((error: unknown) => error);
          const denial = reports.find((event) => event.status === "budget_denied");
          expect(denial).toMatchObject({
            agent_run_id: runId,
            agent_run_name: "velocity-server-order",
            parent_agent_run_id: parentId,
            tags: { org: "sdk", task: "ten" },
          });
        });
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(checks).toBe(2);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(caught).toMatchObject({
      name: "RunStoppedError",
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    const secondCallId = checkBudget.mock.calls[1]?.[0].callId;
    expect(release.mock.calls).toEqual([[secondCallId, 71]]);
    expect(reports.find((event) => event.status === "budget_denied")).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      status: "budget_denied",
      attempt_index: 0,
      input_tokens: 0,
      output_tokens: 0,
      deny_source: "local_velocity",
      deny_reason: "velocity:repeat_size",
      denied_by_period: "run_stopped",
      estimated_output_bound: 100_000_000,
      velocity_flags: ["repeat_size"],
    });
  });

  it("uses the retained server winner rather than a deferred local winner after funding", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock } = makeFetch();
    let checks = 0;
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockImplementation(async () => {
        checks += 1;
        return checks === 1
          ? budgetCheckResult({ allowed: true, remainingBudget: 100 })
          : budgetCheckResult({
              allowed: true,
              remainingBudget: 100,
              leaseId: "lease-retained-server",
              leaseClaimToken: 72,
            });
      });
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const reports: WireEvent[] = [];
    const report = vi
      .spyOn(MetadataReporter.prototype, "report")
      .mockImplementation((event) => reports.push(event as WireEvent));
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 2,
      velocityRepeatWindowS: 60,
    });

    let runId = "";
    let caught: unknown;
    try {
      await run("velocity-retained-server", async () => {
        runId = currentRun()?.agentRunId ?? "";
        await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
        markTerminated(runId, { reason: "server_won", source: "server" });
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(caught).toMatchObject({
      name: "RunStoppedError",
      agentRunId: runId,
      reason: "server_won",
      source: "server",
    });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(release.mock.calls).toEqual([[checkBudget.mock.calls[1]?.[0].callId, 72]]);
    expect(reports.find((event) => event.status === "budget_denied")).toMatchObject({
      deny_source: "run_terminated",
      deny_reason: "server_won",
      denied_by_period: "run_stopped",
      velocity_flags: ["repeat_size"],
    });
  });

  it("does not preempt a buffered dispatch already in flight and gates only the next call", async () => {
    let signalDispatchStarted: (() => void) | undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStarted = resolve;
    });
    let resolveDispatch: ((value: unknown) => void) | undefined;
    const deferredResponse = new Promise<unknown>((resolve) => {
      resolveDispatch = resolve;
    });
    const response = { usage: { prompt_tokens: 3, completion_tokens: 2 } };
    const client = openAIClient(() => {
      signalDispatchStarted?.();
      return deferredResponse;
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
    });

    let runId = "";
    let secondError: unknown;
    try {
      await run("buffered-non-preemption", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const inFlight = solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
        await dispatchStarted;
        markTerminated(runId, { reason: "stop_after_dispatch", source: "local_velocity" });
        resolveDispatch?.(response);
        await expect(inFlight).resolves.toBe(response);
        secondError = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    const budgetChecks = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/v1/budgets/check"),
    );
    expect(client.chat.completions.create).toHaveBeenCalledOnce();
    expect(budgetChecks).toHaveLength(1);
    expect(secondError).toMatchObject({
      name: "RunStoppedError",
      agentRunId: runId,
      reason: "stop_after_dispatch",
      source: "local_velocity",
    });
    expect(ingested.map((event) => event.status)).toEqual(["success", "budget_denied"]);
  });

  it("keeps rate acceleration advisory even when velocity mode is deny", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock } = makeFetch();
    const reports: WireEvent[] = [];
    const report = vi
      .spyOn(MetadataReporter.prototype, "report")
      .mockImplementation((event) => reports.push(event as WireEvent));
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "deny",
      velocityAccelFloorPerMin: 1,
      velocityAccelFactor: 2,
    });

    try {
      await run("velocity-advisory", async () => {
        await expect(
          solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
        ).resolves.toMatchObject({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(reports).toHaveLength(1);
    expect(reports[0]?.velocity_flags).toEqual(["rate_acceleration"]);
  });

  it("keeps one active-stream handle across a discarded wrapper and model failover", async () => {
    const adapter = new ThrowingFirstStreamWrapAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    let runId = "";
    let fallbackPulls = 0;
    async function* firstStream(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: {} }] };
    }
    async function* fallbackStream(): AsyncGenerator<unknown> {
      fallbackPulls += 1;
      yield { choices: [{ delta: {} }] };
    }
    const primary = openAIClient(() => firstStream());
    const fallback = openAIClient(() => {
      markTerminated(runId, { reason: "operator_stop", source: "server" });
      return fallbackStream();
    });
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
      failoverIdempotency: "always",
      fallback: [[fallback, "gpt-fallback"]],
    });

    let caught: unknown;
    try {
      await run("handoff-failover", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const stream = (await solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [],
          stream: true,
        })) as AsyncIterableIterator<unknown>;
        caught = await stream.next().catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(adapter.wrapCalls).toBe(2);
    expect(primary.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fallback.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({ reason: "operator_stop", source: "server" });
    expect(fallbackPulls).toBe(1);
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-handoff-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });

  it("settles a same-provider stopped stream once from usage observed before the discarded item", async () => {
    let rawPulls = 0;
    let closed = 0;
    async function* rawStream(): AsyncGenerator<unknown> {
      try {
        rawPulls += 1;
        yield { choices: [], usage: { prompt_tokens: 6, completion_tokens: 2 } };
        rawPulls += 1;
        yield { choices: [], usage: { prompt_tokens: 900, completion_tokens: 900 } };
      } finally {
        closed += 1;
      }
    }
    const client = openAIClient(() => rawStream());
    const { fetchMock } = makeFetch();
    vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        leaseId: "lease-same-provider-stop",
        leaseClaimToken: 81,
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const settlements: Array<{
      confirm: BudgetConfirmRequest;
      event: WireEvent;
    }> = [];
    vi.spyOn(MetadataReporter.prototype, "reportSettlement").mockImplementation(
      (confirm, event) => {
        settlements.push({ confirm, event: event as WireEvent });
      },
    );
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
    });

    let runId = "";
    let firstItem: IteratorResult<unknown> | undefined;
    let firstError: unknown;
    let repeatedError: unknown;
    try {
      await run("same-provider-stream-stop", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const stream = (await solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [],
          stream: true,
        })) as AsyncIterableIterator<unknown>;
        firstItem = await stream.next();
        markTerminated(runId, { reason: "operator_stop", source: "server" });
        firstError = await stream.next().catch((error: unknown) => error);
        repeatedError = await stream.next().catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(firstItem).toEqual({
      done: false,
      value: { choices: [], usage: { prompt_tokens: 6, completion_tokens: 2 } },
    });
    expect(firstError).toMatchObject({
      name: "RunStoppedError",
      agentRunId: runId,
      reason: "operator_stop",
      source: "server",
    });
    expect(repeatedError).toBe(firstError);
    expect(rawPulls).toBe(2);
    expect(closed).toBe(1);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      confirm: {
        lease_id: "lease-same-provider-stop",
        call_id: expect.any(String),
        provider: "openai",
        model: "gpt-4o",
        token_details: { input_tokens: 6, output_tokens: 2 },
      },
      event: {
        status: "success",
        provider: "openai",
        model: "gpt-4o",
        input_tokens: 6,
        output_tokens: 2,
        token_details: { input_tokens: 6, output_tokens: 2 },
        agent_run_id: runId,
      },
    });
    expect(settlements[0]?.confirm.call_id).toBe(settlements[0]?.event.call_id);
    expect(release).not.toHaveBeenCalled();
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-same-provider-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });

  it("logs exactly one safe warning and preserves a fresh velocity winner if reporting clears state", async () => {
    class SensitiveReportError extends Error {}
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock } = makeFetch();
    const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
    let runId = "";
    const report = vi.spyOn(MetadataReporter.prototype, "report").mockImplementation((event) => {
      if (event.status === "budget_denied") {
        clearRunTermination(runId);
        throw new SensitiveReportError("private telemetry details");
      }
    });
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 2,
      velocityRepeatWindowS: 60,
      logger: { debug() {}, info() {}, warn, error() {} },
    });

    let caught: unknown;
    try {
      await run("safe-report-failure", async () => {
        runId = currentRun()?.agentRunId ?? "";
        await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    const safeReportWarnings = warn.mock.calls.filter(
      ([message]) => message === "Failed to report budget_denied metadata event: %s",
    );
    expect(safeReportWarnings).toEqual([
      ["Failed to report budget_denied metadata event: %s", "SensitiveReportError"],
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Failed to report budget_denied metadata event: %s",
      "SensitiveReportError",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private telemetry details");
  });

  it("warns once per cadence while carrying advisory velocity flags on successes", async () => {
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const { fetchMock } = makeFetch();
    const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
    const reports: WireEvent[] = [];
    const report = vi
      .spyOn(MetadataReporter.prototype, "report")
      .mockImplementation((event) => reports.push(event as WireEvent));
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "warn",
      velocityRepeatCount: 2,
      velocityRepeatWindowS: 60,
      logger: { debug() {}, info() {}, warn, error() {} },
    });

    let runId = "";
    try {
      await run("velocity-warning", async () => {
        runId = currentRun()?.agentRunId ?? "";
        for (let index = 0; index < 3; index += 1) {
          await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
        }
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("velocity.flagged: rule=%s run=%s", "repeat_size", runId);
    expect(reports).toHaveLength(3);
    expect(reports[0]).not.toHaveProperty("velocity_flags");
    expect(reports[1]?.velocity_flags).toEqual(["repeat_size"]);
    expect(reports[2]?.velocity_flags).toEqual(["repeat_size"]);
  });

  it("releases the active handle when Google lazy first-pull establishment rejects", async () => {
    const adapter = new GoogleRecordingAdapter();
    __setAdapterLoadersForTesting({ google: async () => adapter });
    const aborted = new DOMException("lazy request cancelled", "AbortError");
    const rejectedLazyStream = (): AsyncIterable<unknown> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(aborted) }),
    });
    const client = {
      models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(() => rejectedLazyStream()),
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "google",
      leaseEnabled: false,
      velocityMode: "off",
    });

    let runId = "";
    try {
      await run("google-lazy-cleanup", async () => {
        runId = currentRun()?.agentRunId ?? "";
        await expect(
          (
            solwyn as unknown as {
              models: {
                generateContentStream(kwargs: Record<string, unknown>): Promise<unknown>;
              };
            }
          ).models.generateContentStream({ model: "gemini-2.0-flash", contents: [] }),
        ).rejects.toBe(aborted);
      });
    } finally {
      await solwyn.close();
    }

    markTerminated(runId, { reason: "after_lazy_failure", source: "server" });
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-google-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// responses.create interception.
// ---------------------------------------------------------------------------

describe("SolwynCore — responses.create interception", () => {
  it("routes responses.create through the pipeline and extracts the Responses-API usage shape", async () => {
    const responsesCreate = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { input_tokens: 30, output_tokens: 9 },
      service_tier: "default",
    }));
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: responsesCreate },
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.responses.create({ model: "gpt-4o", input: "hi" });
    await solwyn.close();

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("success");
    expect(event.input_tokens).toBe(30);
    expect(event.output_tokens).toBe(9);
  });

  it("settles a Responses STREAM's usage from the terminal response.completed event", async () => {
    // Responses streaming events: usage lands on the terminal `response.completed`
    // event's nested `response.usage` (Responses-API shape), NOT on a top-level chunk
    // `usage` like Chat Completions. The chat-shaped accumulator would settle zeros here.
    async function* responsesStream(): AsyncGenerator<unknown> {
      yield { type: "response.created", response: { id: "resp_1", usage: null } };
      yield { type: "response.output_text.delta", delta: "hi" };
      yield {
        type: "response.completed",
        response: {
          service_tier: "flex",
          usage: { input_tokens: 42, output_tokens: 13 },
        },
      };
    }
    const responsesCreate = vi.fn((_kwargs: Record<string, unknown>) => responsesStream());
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: responsesCreate },
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const stream = (await solwyn.responses.create({
      model: "gpt-4o",
      input: "hi",
      stream: true,
    })) as AsyncIterable<unknown>;

    // The Responses stream is dispatched with `stream: true` but NO stream_options
    // (include_usage is a Chat Completions concept the Responses API 4xxes on).
    const passedKwargs = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passedKwargs["stream"]).toBe(true);
    expect(passedKwargs["stream_options"]).toBeUndefined();

    let count = 0;
    for await (const _chunk of stream) {
      count += 1;
    }
    await solwyn.close();

    expect(count).toBe(3);
    expect(ingested).toHaveLength(1);
    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("success");
    expect(event.input_tokens).toBe(42);
    expect(event.output_tokens).toBe(13);
    expect(event.service_tier).toBe("flex");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

describe("SolwynCore — lifecycle", () => {
  it("close() flushes queued events to the reporter transport", async () => {
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(ingested).toHaveLength(0); // not yet flushed (background loop / close)
    await solwyn.close();
    expect(ingested).toHaveLength(1);
  });

  it("Symbol.asyncDispose delegates to close() and flushes", async () => {
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await (solwyn as unknown as { [Symbol.asyncDispose](): Promise<void> })[Symbol.asyncDispose]();
    expect(ingested).toHaveLength(1);
  });

  it("closes reporter, budget, then provider with the provider receiver and awaits a thenable", async () => {
    const order: string[] = [];
    const originalReporterClose = MetadataReporter.prototype.close;
    const originalBudgetClose = BudgetEnforcer.prototype.close;
    const reporterClose = vi
      .spyOn(MetadataReporter.prototype, "close")
      .mockImplementation(function (this: MetadataReporter): Promise<void> {
        order.push("reporter");
        return originalReporterClose.call(this);
      });
    const budgetClose = vi.spyOn(BudgetEnforcer.prototype, "close").mockImplementation(function (
      this: BudgetEnforcer,
    ): Promise<void> {
      order.push("budget");
      return originalBudgetClose.call(this);
    });
    let providerReceiver: unknown;
    const client = {
      ...openAIClient(() => ({})),
      close: vi.fn(function (this: unknown) {
        providerReceiver = this;
        order.push("provider");
        return {
          // biome-ignore lint/suspicious/noThenProperty: lifecycle handling requires awaiting arbitrary provider thenables.
          then(resolve: () => void): void {
            order.push("thenable");
            queueMicrotask(() => {
              order.push("provider-settled");
              resolve();
            });
          },
        };
      }),
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    try {
      await solwyn.close();
      expect(order).toEqual(["reporter", "budget", "provider", "thenable", "provider-settled"]);
      expect(providerReceiver).toBe(client);
      expect(client.close).toHaveBeenCalledTimes(1);
    } finally {
      reporterClose.mockRestore();
      budgetClose.mockRestore();
    }
  });

  it("returns one close promise for concurrent, disposal, and post-settlement calls", async () => {
    const client = {
      ...openAIClient(() => ({})),
      close: vi.fn(async () => Promise.resolve()),
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const first = solwyn.close();
    const concurrent = solwyn.close();
    const disposed = (solwyn as unknown as { [Symbol.asyncDispose](): Promise<void> })[
      Symbol.asyncDispose
    ]();
    expect(concurrent).toBe(first);
    expect(disposed).toBe(first);
    await first;

    const repeated = solwyn.close();
    expect(repeated).toBe(first);
    await repeated;
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("installs the close promise before reporter shutdown can synchronously reenter", async () => {
    const originalReporterClose = MetadataReporter.prototype.close;
    let wrapper!: { close(): Promise<void> };
    let reentered: Promise<void> | undefined;
    let reporterCalls = 0;
    const reporterClose = vi
      .spyOn(MetadataReporter.prototype, "close")
      .mockImplementation(function (this: MetadataReporter): Promise<void> {
        reporterCalls += 1;
        if (reporterCalls === 1) {
          reentered = wrapper.close();
        }
        return originalReporterClose.call(this);
      });
    const { fetchMock } = makeFetch();
    wrapper = new Solwyn(
      openAIClient(() => ({})),
      {
        apiKey: API_KEY,
        fetch: fetchMock,
      },
    );

    try {
      const first = wrapper.close();
      await first;
      expect(reentered).toBe(first);
      expect(reporterClose).toHaveBeenCalledOnce();
    } finally {
      reporterClose.mockRestore();
    }
  });

  it("treats missing and non-function provider close values as fail-soft", async () => {
    const { fetchMock } = makeFetch();
    const missing = new Solwyn(
      openAIClient(() => ({})),
      {
        apiKey: API_KEY,
        fetch: fetchMock,
      },
    );
    const nonFunction = new Solwyn(
      { ...openAIClient(() => ({})), close: "not callable" },
      { apiKey: API_KEY, fetch: fetchMock },
    );

    await expect(missing.close()).resolves.toBeUndefined();
    await expect(nonFunction.close()).resolves.toBeUndefined();
  });

  it("memoizes and propagates a provider close getter error without rereading it", async () => {
    const sentinel = new Error("provider close getter failed");
    let getterReads = 0;
    const client = openAIClient(() => ({})) as ReturnType<typeof openAIClient> & {
      close?: unknown;
    };
    Object.defineProperty(client, "close", {
      configurable: true,
      get(): never {
        getterReads += 1;
        throw sentinel;
      },
    });
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const first = solwyn.close();
    const concurrent = solwyn.close();
    expect(concurrent).toBe(first);
    await expect(first).rejects.toBe(sentinel);
    const repeated = solwyn.close();
    expect(repeated).toBe(first);
    await expect(repeated).rejects.toBe(sentinel);
    expect(getterReads).toBe(1);
  });

  it.each([
    "throw",
    "reject",
  ] as const)("memoizes and propagates a provider close %s error", async (failureMode) => {
    const sentinel = new Error(`provider close ${failureMode} failed`);
    const close = vi.fn(() => {
      if (failureMode === "throw") {
        throw sentinel;
      }
      return Promise.reject(sentinel);
    });
    const client = { ...openAIClient(() => ({})), close };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const first = solwyn.close();
    const concurrent = solwyn.close();
    expect(concurrent).toBe(first);
    await expect(first).rejects.toBe(sentinel);
    const repeated = solwyn.close();
    expect(repeated).toBe(first);
    await expect(repeated).rejects.toBe(sentinel);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Options validation.
// ---------------------------------------------------------------------------

describe("SolwynCore — options validation", () => {
  it("throws ConfigurationError synchronously on a missing/invalid apiKey", () => {
    const client = openAIClient(() => ({}));
    expect(() => new Solwyn(client, {})).toThrow(ConfigurationError);
    expect(() => new Solwyn(client, { apiKey: "not-a-key" })).toThrow(ConfigurationError);
  });

  it("rejects an unknown/renamed option (e.g. projectId)", () => {
    const client = openAIClient(() => ({}));
    expect(
      () =>
        new Solwyn(client, {
          apiKey: API_KEY,
          projectId: "proj_x",
        } as unknown as { apiKey: string }),
    ).toThrow(ConfigurationError);
  });

  it("maps the public failoverHopReadTimeout option and preserves typed boolean rejection", async () => {
    const client = openAIClient(() => ({}));
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      failoverHopReadTimeout: 42,
    });
    await solwyn.close();

    let caught: unknown;
    try {
      new Solwyn(client, {
        apiKey: API_KEY,
        fetch: fetchMock,
        failoverHopReadTimeout: true,
      } as unknown as { apiKey: string });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("failover_hop_read_timeout");
    expect((caught as ConfigurationError).message).toBe(
      "timeout bounds must be numbers, not booleans",
    );
  });

  it("wires configured control-plane breaker thresholds into budget checks", async () => {
    let checkCalls = 0;
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      if (url.includes("/api/v1/budgets/check")) {
        checkCalls += 1;
        return new Response("", { status: 500 });
      }
      return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
    });
    const client = openAIClient(() => ({}));
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      budgetCheckCacheTtl: 0,
      budgetCheckTimeout: 0.25,
      controlPlaneFailureThreshold: 1,
      controlPlaneRecoveryTimeout: 30,
      breakerReportingEnabled: false,
    });

    await solwyn.chat.completions.create({ model: "gpt-4o" });
    await solwyn.chat.completions.create({ model: "gpt-4o" });
    await solwyn.close();

    expect(checkCalls).toBe(1);
  });

  it("admits valid client default tags as an inert constructor option", async () => {
    const client = openAIClient(() => ({}));
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      tags: { team: "platform", empty: "" },
    });
    await solwyn.close();
  });

  it("rejects invalid tags synchronously before reading fetch or starting resources", () => {
    const client = openAIClient(() => ({}));
    let fetchRead = false;
    const options = {
      apiKey: API_KEY,
      tags: "team=platform",
      get fetch(): FetchLike {
        fetchRead = true;
        return async () => new Response(null, { status: 204 });
      },
    };

    let caught: unknown;
    try {
      new Solwyn(client, options as unknown as SolwynOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("tags");
    expect(fetchRead).toBe(false);
  });

  it("rejects an unrecognized provider SDK synchronously at construction", () => {
    const stranger = { totally: "unknown" };
    const { fetchMock } = makeFetch();
    let caught: unknown;
    try {
      new Solwyn(stranger, { apiKey: API_KEY, fetch: fetchMock });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({ field: "provider" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// estimate-missing-usage overwrite and zero-content guard (stub adapter).
// ---------------------------------------------------------------------------

/** A one-usage accumulator stub (unused by the buffered path under test). */
function stubAccumulator(): StreamUsageAccumulator {
  return {
    observe: () => {},
    finalize: () => zeroTokenDetails(),
    getServiceTier: () => null,
  };
}

/** A stub adapter recording every `estimateMissingUsage` call and always overwriting usage. */
class RecordingAdapter implements ProviderAdapter {
  readonly name: string;
  readonly dialect: Dialect;
  readonly estimateCalls: EstimateMissingUsageOptions[] = [];

  constructor(options: { name?: string; dialect?: Dialect } = {}) {
    this.name = options.name ?? "openai";
    this.dialect = options.dialect ?? "openai";
  }

  detectClient(client: unknown): boolean {
    return (
      typeof (client as { chat?: { completions?: { create?: unknown } } })?.chat?.completions
        ?.create === "function"
    );
  }
  detectModel(): boolean {
    return false;
  }
  extractUsage(): TokenDetails {
    // Pretend the provider reported nothing, so the estimate must win.
    return zeroTokenDetails();
  }
  estimateMissingUsage(
    _response: unknown,
    options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    this.estimateCalls.push(options);
    return createTokenDetails({
      input_tokens: options.estimatedInputTokens,
      output_tokens: 1,
      is_estimated: true,
    });
  }
  extractServiceTier(): string | null {
    return null;
  }
  extractRegion(): string | null {
    return null;
  }
  prepareStreaming(kwargs: Record<string, unknown>): Record<string, unknown> {
    return { ...kwargs };
  }
  createStreamAccumulator(_options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    return stubAccumulator();
  }
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    _options: PrepareCallOptions,
  ): PreparedDispatch {
    const completions = (
      client as { chat: { completions: { create: (...a: unknown[]) => unknown } } }
    ).chat.completions;
    const shaped = { ...kwargs };
    return (...passthroughArgs) => completions.create(shaped, ...passthroughArgs);
  }
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }
  wrapStreamResult(wrapper: unknown): unknown {
    return wrapper;
  }
}

/** Google-dialect variant used to reach the lazy first-pull boundary through its real surface. */
class GoogleRecordingAdapter extends RecordingAdapter {
  constructor() {
    super({ name: "google", dialect: "google" });
  }

  override prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    const models = (
      client as {
        models: {
          generateContent: (...args: unknown[]) => unknown;
          generateContentStream: (...args: unknown[]) => unknown;
        };
      }
    ).models;
    const call = options.isStreaming ? models.generateContentStream : models.generateContent;
    return (...passthroughArgs) => call.call(models, { ...kwargs }, ...passthroughArgs);
  }
}

class ThrowingFirstStreamWrapAdapter extends RecordingAdapter {
  wrapCalls = 0;

  override wrapStreamResult(wrapper: unknown): unknown {
    this.wrapCalls += 1;
    if (this.wrapCalls === 1) {
      throw Object.assign(new Error("first result shape failed"), { status: 503 });
    }
    return wrapper;
  }
}

class FailSoftAdapter extends RecordingAdapter {
  readonly supportsResponses = true;
  extractUsageImpl: () => TokenDetails = () => zeroTokenDetails();
  estimateUsageImpl: (options: EstimateMissingUsageOptions) => TokenDetails | null = () => null;
  serviceTierImpl: () => string | null = () => null;
  regionImpl: () => string | null = () => null;
  accumulatorImpl: () => StreamUsageAccumulator = () => stubAccumulator();

  override extractUsage(): TokenDetails {
    return this.extractUsageImpl();
  }

  override estimateMissingUsage(
    _response: unknown,
    options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    return this.estimateUsageImpl(options);
  }

  override extractServiceTier(): string | null {
    return this.serviceTierImpl();
  }

  override extractRegion(): string | null {
    return this.regionImpl();
  }

  override createStreamAccumulator(): StreamUsageAccumulator {
    return this.accumulatorImpl();
  }

  override prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    const shaped = { ...kwargs, ...(options.isStreaming ? { stream: true } : {}) };
    if (options.surface === "responses") {
      const responses = (client as { responses: { create: (...args: unknown[]) => unknown } })
        .responses;
      return (...passthroughArgs) => responses.create(shaped, ...passthroughArgs);
    }
    const completions = (
      client as { chat: { completions: { create: (...args: unknown[]) => unknown } } }
    ).chat.completions;
    return (...passthroughArgs) => completions.create(shaped, ...passthroughArgs);
  }
}

function installFailSoftFundingDecision() {
  const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
    budgetCheckResult({
      allowed: true,
      remainingBudget: 900,
      projectId: `proj_${"0".repeat(24)}`,
      leaseId: "lease-fail-soft",
      leaseClaimToken: 77,
    }),
  );
  const releaseReservation = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
  const buildConfirmRequest = vi
    .spyOn(BudgetEnforcer.prototype, "buildConfirmRequest")
    .mockImplementation(
      (options): BudgetConfirmRequest => ({
        lease_id: options.leaseId ?? "lease-fail-soft",
        model: options.model,
        provider: options.provider,
        modality: options.modality ?? "text",
        is_provider_fallback: options.isProviderFallback ?? false,
        call_id: options.callId,
        token_details: options.tokenDetails,
        provider_region: options.providerRegion ?? null,
        service_tier: (options.serviceTier ?? null) as BudgetConfirmRequest["service_tier"],
      }),
    );
  const reportSettlement = vi.spyOn(MetadataReporter.prototype, "reportSettlement");
  return { checkBudget, releaseReservation, buildConfirmRequest, reportSettlement };
}

async function* streamOf(value: unknown): AsyncGenerator<unknown> {
  yield value;
}

describe("SolwynCore — active-stream handle cleanup across terminal setup branches", () => {
  afterEach(() => {
    resetRunControlForTest();
    __resetAdapterRegistry();
    vi.restoreAllMocks();
  });

  const terminalCases: Array<{
    readonly name: string;
    readonly build: () => {
      readonly adapter: RecordingAdapter;
      readonly primary: ReturnType<typeof openAIClient>;
      readonly options?: SolwynOptions;
      readonly sentinel?: unknown;
    };
  }> = [
    {
      name: "selection returns no candidate",
      build: () => {
        const adapter = new RecordingAdapter();
        const selectionPolicy: SelectionPolicy = { order: () => [] };
        return {
          adapter,
          primary: openAIClient(() => {
            throw new Error("must not dispatch");
          }),
          options: { selectionPolicy },
        };
      },
    },
    {
      name: "direct terminal dispatch rejection",
      build: () => {
        const adapter = new RecordingAdapter();
        const sentinel = Object.assign(new Error("terminal request"), { status: 400 });
        return {
          adapter,
          primary: openAIClient(() => {
            throw sentinel;
          }),
          sentinel,
        };
      },
    },
    {
      name: "unwrap rejection",
      build: () => {
        const adapter = new RecordingAdapter();
        const sentinel = new Error("unwrap terminal");
        adapter.unwrapStreamSource = () => {
          throw sentinel;
        };
        return { adapter, primary: openAIClient(() => ({})), sentinel };
      },
    },
    {
      name: "non-iterable stream source",
      build: () => ({
        adapter: new RecordingAdapter(),
        primary: openAIClient(() => ({})),
      }),
    },
    {
      name: "accumulator construction rejection",
      build: () => {
        const adapter = new RecordingAdapter();
        const sentinel = new Error("accumulator terminal");
        adapter.createStreamAccumulator = () => {
          throw sentinel;
        };
        return { adapter, primary: openAIClient(() => streamOf({ chunk: 1 })), sentinel };
      },
    },
    {
      name: "result-shaping rejection",
      build: () => {
        const adapter = new RecordingAdapter();
        const sentinel = Object.assign(new Error("shape terminal"), { status: 400 });
        adapter.wrapStreamResult = () => {
          throw sentinel;
        };
        return { adapter, primary: openAIClient(() => streamOf({ chunk: 1 })), sentinel };
      },
    },
    {
      name: "exhausted failover",
      build: () => {
        const adapter = new RecordingAdapter();
        const primaryFailure = Object.assign(new Error("primary unavailable"), { status: 429 });
        const fallbackFailure = Object.assign(new Error("fallback unavailable"), { status: 429 });
        const fallback = openAIClient(() => {
          throw fallbackFailure;
        });
        return {
          adapter,
          primary: openAIClient(() => {
            throw primaryFailure;
          }),
          options: { fallback: [[fallback, "gpt-fallback", {}, "openai"]] },
        };
      },
    },
  ];

  it.each(terminalCases)("releases the client-owned watcher when $name", async (scenario) => {
    const { adapter, primary, options = {}, sentinel } = scenario.build();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(primary, {
      ...options,
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
      failoverIdempotency: "always",
    });

    let runId = "";
    let caught: unknown;
    try {
      await run(`terminal-${scenario.name}`, async () => {
        runId = currentRun()?.agentRunId ?? "";
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [], stream: true })
          .catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(caught).toBeInstanceOf(Error);
    if (sentinel !== undefined) {
      expect(caught).toBe(sentinel);
    }
    markTerminated(runId, { reason: "after_terminal", source: "server" });
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-terminal-${scenario.name}-${index}`, {
        reason: "evict",
        source: "server",
      });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });
});

describe("SolwynCore — estimateMissingUsage overwrite + zero-content guard (D8)", () => {
  afterEach(() => {
    __resetAdapterRegistry();
  });

  it("sizes the estimate from content length and lets a non-null estimate overwrite usage", async () => {
    const adapter = new RecordingAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });

    const client = openAIClient(() => ({}));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    // 8 chars of content -> floor(8 / 4.0) = 2 estimated input tokens (openai ratio).
    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "abcdefgh" }],
    });
    await solwyn.close();

    expect(adapter.estimateCalls[0]?.estimatedInputTokens).toBe(2);
    const event = ingested[0] as WireEvent;
    // The estimate overwrote the (zero) extracted usage; is_estimated rides through.
    expect(event.input_tokens).toBe(2);
    expect(event.output_tokens).toBe(1);
    expect((event.token_details as TokenDetails).is_estimated).toBe(true);
  });

  it("estimates 0 tokens for genuinely empty content (bypasses the min-1 floor)", async () => {
    const adapter = new RecordingAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });

    const client = openAIClient(() => ({}));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(adapter.estimateCalls[0]?.estimatedInputTokens).toBe(0);
    expect((ingested[0] as WireEvent).input_tokens).toBe(0);
  });
});

describe("SolwynCore — fail-soft post-success bookkeeping", () => {
  afterEach(() => {
    __resetAdapterRegistry();
    vi.restoreAllMocks();
  });

  it.each([
    "chat",
    "responses",
  ] as const)("returns the exact paid %s response and floors only synthetic unmeasured usage", async (surface) => {
    const adapter = new FailSoftAdapter();
    adapter.extractUsageImpl = () => {
      throw new TypeError("usage read failed");
    };
    adapter.estimateUsageImpl = () => null;
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const response = { id: `${surface}-paid-response` };
    const chatCreate = vi.fn((_kwargs: Record<string, unknown>) => response);
    const responsesCreate = vi.fn((_kwargs: Record<string, unknown>) => response);
    const client = {
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
    };
    const { fetchMock, ingested } = makeFetch();
    const funding = installFailSoftFundingDecision();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const result =
      surface === "chat"
        ? await solwyn.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "abcd" }],
          })
        : await solwyn.responses.create({ model: "gpt-4o", input: "abcd" });
    expect(result).toBe(response);
    await solwyn.close();

    expect(funding.buildConfirmRequest).toHaveBeenCalledOnce();
    const options = funding.buildConfirmRequest.mock.calls[0]?.[0];
    expect(options?.tokenDetails).toMatchObject({
      input_tokens: 1,
      output_tokens: 0,
      is_estimated: true,
    });
    expect(options?.floorAtReservation).toBe(true);
    expect(funding.reportSettlement).toHaveBeenCalledOnce();
    expect(funding.releaseReservation).not.toHaveBeenCalled();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      status: "success",
      input_tokens: 1,
      output_tokens: 0,
    });
  });

  it("keeps zero usage measured and omits failing region and tier without losing settlement", async () => {
    const adapter = new FailSoftAdapter();
    adapter.extractUsageImpl = () => zeroTokenDetails();
    adapter.regionImpl = () => {
      throw new TypeError("region read failed");
    };
    adapter.serviceTierImpl = () => {
      throw new TypeError("tier read failed");
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const response = { id: "zero-is-measured" };
    const client = openAIClient(() => response);
    const { fetchMock, ingested } = makeFetch();
    const funding = installFailSoftFundingDecision();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).resolves.toBe(
      response,
    );
    await solwyn.close();

    const options = funding.buildConfirmRequest.mock.calls[0]?.[0];
    expect(options?.tokenDetails).toBeDefined();
    expect(options?.floorAtReservation).toBe(false);
    expect(options?.providerRegion).toBeNull();
    expect(options?.serviceTier).toBeNull();
    expect(funding.reportSettlement).toHaveBeenCalledOnce();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).not.toHaveProperty("provider_region");
    expect(ingested[0]).not.toHaveProperty("service_tier");
  });

  it("preserves a typed budget denial when region extraction throws", async () => {
    const adapter = new FailSoftAdapter();
    adapter.regionImpl = () => {
      throw new TypeError("region read failed");
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        mode: "hard_deny",
        budgetLimit: 100,
        currentUsage: 100,
        deniedByPeriod: "monthly",
      }),
    );
    const client = openAIClient(() => ({ id: "must-not-dispatch" }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await expect(
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).rejects.toMatchObject({ name: "BudgetExceededError" });
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    await solwyn.close();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).not.toHaveProperty("provider_region");
  });

  it("preserves the exact provider error when failed-hop region extraction throws", async () => {
    const adapter = new FailSoftAdapter();
    adapter.regionImpl = () => {
      throw new TypeError("region read failed");
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const sentinel = new Error("provider failed");
    const client = openAIClient(() => {
      throw sentinel;
    });
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
      sentinel,
    );
    await solwyn.close();
  });

  it("contains stream region and terminal tier failures, drains chunks, and settles once without a floor", async () => {
    const adapter = new FailSoftAdapter();
    adapter.regionImpl = () => {
      throw new TypeError("region read failed");
    };
    adapter.accumulatorImpl = () => ({
      observe() {},
      finalize: () => createTokenDetails({ input_tokens: 4, output_tokens: 3 }),
      getServiceTier() {
        throw new TypeError("tier read failed");
      },
    });
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    async function* chunks(): AsyncGenerator<unknown> {
      yield { chunk: 1 };
      yield { chunk: 2 };
    }
    const client = openAIClient(() => chunks());
    const { fetchMock, ingested } = makeFetch();
    const funding = installFailSoftFundingDecision();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    const received: unknown[] = [];
    for await (const chunk of stream) received.push(chunk);
    await solwyn.close();

    expect(received).toEqual([{ chunk: 1 }, { chunk: 2 }]);
    expect(funding.buildConfirmRequest).toHaveBeenCalledOnce();
    expect(funding.buildConfirmRequest.mock.calls[0]?.[0]).not.toHaveProperty("floorAtReservation");
    expect(funding.reportSettlement).toHaveBeenCalledOnce();
    expect(funding.releaseReservation).not.toHaveBeenCalled();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).not.toHaveProperty("provider_region");
    expect(ingested[0]).not.toHaveProperty("service_tier");
  });

  it("keeps accumulator finalization loud and uses the existing error-and-release path", async () => {
    const adapter = new FailSoftAdapter();
    const sentinel = new Error("finalization stays loud");
    adapter.accumulatorImpl = () => ({
      observe() {},
      finalize() {
        throw sentinel;
      },
      getServiceTier: () => null,
    });
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    async function* chunks(): AsyncGenerator<unknown> {
      yield { chunk: 1 };
    }
    const client = openAIClient(() => chunks());
    const { fetchMock, ingested } = makeFetch();
    const funding = installFailSoftFundingDecision();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          // drain until terminal finalization
        }
      })(),
    ).rejects.toBe(sentinel);
    await solwyn.close();

    expect(funding.buildConfirmRequest).not.toHaveBeenCalled();
    expect(funding.releaseReservation).toHaveBeenCalledOnce();
    expect(ingested.filter((event) => event.status === "error")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The default logger is console-backed.
// ---------------------------------------------------------------------------

describe("SolwynCore — default logger is console-backed (D6/F7)", () => {
  it("routes reporter warnings to the console by default when no logger is injected", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      // A malformed 202 body forces a reporter ingest-response-unparseable WARNING —
      // discarded under the old noop default, visible under the console-backed default.
      const impl: FetchLike = async () => new Response("[]", { status: 202 });
      const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: vi.fn(impl) });

      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
      await solwyn.close();

      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes("ingest_response_unparseable")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Streaming establishment failures report an error event.
// ---------------------------------------------------------------------------

describe("SolwynCore — streaming establishment error reporting (F8/F12)", () => {
  it("reports a status=error event before rethrowing when the streaming create rejects", async () => {
    const boom = new ProviderBoom();
    const client = openAIClient(() => {
      throw boom;
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await expect(
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [], stream: true }),
    ).rejects.toBe(boom);
    await solwyn.close();

    // Old behavior: the streaming path swallowed the establishment failure (0 events).
    expect(ingested).toHaveLength(1);
    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("error");
    expect(event.failover_error_class).toBe("ProviderBoom");
    expect(event.input_tokens).toBe(0);
    expect(JSON.stringify(event)).not.toContain("upstream 500");
  });

  it("preserves result-wrapping failure when non-success source cleanup also fails", async () => {
    const sentinel = new Error("wrap result failed");
    const cleanupFailure = new Error("source cleanup failed");
    const aclose = vi.fn(() => {
      throw cleanupFailure;
    });
    const close = vi.fn();
    const source = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield { choices: [{ delta: {} }] };
      },
      aclose,
      close,
    };
    const adapter = new RecordingAdapter();
    adapter.wrapStreamResult = () => {
      throw sentinel;
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        leaseId: "lease-client-setup",
        leaseClaimToken: 88,
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const { fetchMock, ingested, confirms } = makeFetch();
    const solwyn = new Solwyn(
      openAIClient(() => source),
      {
        apiKey: API_KEY,
        fetch: fetchMock,
      },
    );

    try {
      await expect(
        solwyn.chat.completions.create({ model: "gpt-5.5", messages: [], stream: true }),
      ).rejects.toBe(sentinel);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(aclose).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(release.mock.calls).toEqual([[callId, 88]]);
      await solwyn.close();
      expect(confirms).toHaveLength(0);
      expect(ingested.some((event) => event.status === "success")).toBe(false);
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
      __resetAdapterRegistry();
    }
  });

  it("preserves unwrap failure when raw-response cleanup also fails", async () => {
    const sentinel = new Error("unwrap failed");
    const cleanupFailure = new Error("raw response cleanup failed");
    const aclose = vi.fn(() => {
      throw cleanupFailure;
    });
    const close = vi.fn();
    const rawResponse = { aclose, close };
    const adapter = new RecordingAdapter();
    adapter.unwrapStreamSource = () => {
      throw sentinel;
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        leaseId: "lease-client-unwrap",
        leaseClaimToken: 89,
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const { fetchMock, ingested, confirms } = makeFetch();
    const solwyn = new Solwyn(
      openAIClient(() => rawResponse),
      {
        apiKey: API_KEY,
        fetch: fetchMock,
      },
    );

    try {
      await expect(
        solwyn.chat.completions.create({ model: "gpt-5.5", messages: [], stream: true }),
      ).rejects.toBe(sentinel);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(aclose).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(release.mock.calls).toEqual([[callId, 89]]);
      await solwyn.close();
      expect(confirms).toHaveLength(0);
      expect(ingested.some((event) => event.status === "success")).toBe(false);
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
      __resetAdapterRegistry();
    }
  });

  it("preserves Google lazy-materialization failure when source cleanup also fails", async () => {
    const sentinel = new Error("lazy first pull failed");
    const cleanupFailure = new Error("lazy source cleanup failed");
    const next = vi.fn(async (): Promise<IteratorResult<unknown>> => {
      throw sentinel;
    });
    const aclose = vi.fn(() => {
      throw cleanupFailure;
    });
    const close = vi.fn();
    const source = {
      [Symbol.asyncIterator]: () => ({ next }),
      aclose,
      close,
    };
    const adapter = new GoogleRecordingAdapter();
    __setAdapterLoadersForTesting({ google: async () => adapter });
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        leaseId: "lease-client-google-lazy",
        leaseClaimToken: 90,
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const { fetchMock, ingested, confirms } = makeFetch();
    const client = {
      models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(() => source),
      },
    };
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "google",
    });

    try {
      await expect(
        (
          solwyn as unknown as {
            models: {
              generateContentStream(kwargs: Record<string, unknown>): Promise<unknown>;
            };
          }
        ).models.generateContentStream({ model: "gemini-2.5-pro", contents: [] }),
      ).rejects.toBe(sentinel);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(next).toHaveBeenCalledOnce();
      expect(aclose).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(release.mock.calls).toEqual([[callId, 90]]);
      await solwyn.close();
      expect(confirms).toHaveLength(0);
      expect(ingested.some((event) => event.status === "success")).toBe(false);
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
      __resetAdapterRegistry();
    }
  });

  it("preserves accumulator-construction failure when source cleanup also fails", async () => {
    const sentinel = new Error("accumulator construction failed");
    const cleanupFailure = new Error("accumulator source cleanup failed");
    const aclose = vi.fn(() => {
      throw cleanupFailure;
    });
    const close = vi.fn();
    const source = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield { choices: [{ delta: {} }] };
      },
      aclose,
      close,
    };
    const adapter = new RecordingAdapter();
    adapter.createStreamAccumulator = () => {
      throw sentinel;
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        leaseId: "lease-client-accumulator",
        leaseClaimToken: 91,
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const { fetchMock, ingested, confirms } = makeFetch();
    const solwyn = new Solwyn(
      openAIClient(() => source),
      {
        apiKey: API_KEY,
        fetch: fetchMock,
      },
    );

    try {
      await expect(
        solwyn.chat.completions.create({ model: "gpt-5.5", messages: [], stream: true }),
      ).rejects.toBe(sentinel);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(aclose).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(release.mock.calls).toEqual([[callId, 91]]);
      await solwyn.close();
      expect(confirms).toHaveLength(0);
      expect(ingested.some((event) => event.status === "success")).toBe(false);
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
      __resetAdapterRegistry();
    }
  });
});

// ---------------------------------------------------------------------------
// Error events report measured latency rather than zero.
// ---------------------------------------------------------------------------

describe("SolwynCore — error event latency (F17)", () => {
  it("reports the MEASURED elapsed latency on a buffered dispatch failure, not 0", async () => {
    const boom = new ProviderBoom();
    const client = openAIClient(async () => {
      await sleep(20);
      throw boom;
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
      boom,
    );
    await solwyn.close();

    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("error");
    expect(event.latency_ms).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Truthy stream coercion: an untyped `stream: 1` still streams.
// ---------------------------------------------------------------------------

describe("SolwynCore — truthy stream coercion (F19)", () => {
  it("treats a truthy non-boolean stream flag as streaming (injects include_usage, settles at end)", async () => {
    const client = openAIClient(() => fakeStream());
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: 1,
    })) as AsyncIterable<unknown>;

    // The streaming pipeline ran: include_usage is injected (buffered path never does).
    const passedKwargs = client.chat.completions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(passedKwargs["stream_options"]).toEqual({ include_usage: true });

    let count = 0;
    for await (const _chunk of stream) {
      count += 1;
    }
    await solwyn.close();

    // Old behavior: `=== true` took the buffered path — a zero-usage event fired
    // immediately and the raw unwrapped generator was returned.
    expect(count).toBe(3);
    expect(ingested).toHaveLength(1);
    expect((ingested[0] as WireEvent).input_tokens).toBe(5);
    expect((ingested[0] as WireEvent).output_tokens).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Usage extraction never throws; the wire boundary drops malformed data fail-open.
// ---------------------------------------------------------------------------

describe("SolwynCore — usage extraction never throws (F10)", () => {
  it("does not throw on an out-of-bound usage count; returns the response, drops the event fail-open", async () => {
    const response = { usage: { prompt_tokens: 100_000_001, completion_tokens: 1 } };
    const client = openAIClient(() => response);
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      // Silence the expected fail-open drop warning (the point under test is no throw).
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const report = vi.spyOn(MetadataReporter.prototype, "report");

    // The provider call succeeded — the caller receives the response, NOT a ZodError.
    const result = await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(result).toBe(response);
    await solwyn.close();

    // The over-cap count fails MetadataEventSchema at the reporter boundary, so the
    // single offending event is dropped fail-open — no crash, no partial batch.
    expect(ingested).toHaveLength(0);
    const rawEvent = report.mock.calls[0]?.[0];
    report.mockRestore();
    expect(rawEvent).toMatchObject({
      input_tokens: 100_000_000,
      output_tokens: 1,
      token_details: { input_tokens: 100_000_001, output_tokens: 1 },
    });
  });
});

describe("SolwynCore — receipt event boundaries", () => {
  it("defensively copies non-empty velocity flags and omits empty lists", () => {
    const flags: VelocityFlag[] = ["repeat_size"];
    const copied = materializeVelocityFlags(flags);
    flags.push("monotonic_growth");

    expect(copied).toEqual(["repeat_size"]);
    expect(materializeVelocityFlags([])).toBeUndefined();
    expect(materializeVelocityFlags(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming settlement latency and mid-stream error events.
//
// A streaming-capable stub adapter that reports a fixed region and settles to a fixed
// TokenDetails, so region propagation and dispatch-relative latency are observable.
// ---------------------------------------------------------------------------

class RegionStreamingAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly dialect: Dialect = "openai";
  constructor(
    readonly region: string,
    readonly finalizeTokens: TokenDetails,
  ) {}
  detectClient(client: unknown): boolean {
    return (
      typeof (client as { chat?: { completions?: { create?: unknown } } })?.chat?.completions
        ?.create === "function"
    );
  }
  detectModel(): boolean {
    return false;
  }
  extractUsage(): TokenDetails {
    return zeroTokenDetails();
  }
  estimateMissingUsage(): TokenDetails | null {
    return null;
  }
  extractServiceTier(): string | null {
    return null;
  }
  extractRegion(): string | null {
    return this.region;
  }
  prepareStreaming(kwargs: Record<string, unknown>): Record<string, unknown> {
    return { ...kwargs };
  }
  createStreamAccumulator(_options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    const tokens = this.finalizeTokens;
    return {
      observe: () => {},
      finalize: () => tokens,
      getServiceTier: () => null,
    };
  }
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    const completions = (
      client as { chat: { completions: { create: (...a: unknown[]) => unknown } } }
    ).chat.completions;
    const shaped: Record<string, unknown> = { ...kwargs };
    if (options.isStreaming) {
      shaped["stream"] = true;
    }
    return (...passthroughArgs) => completions.create(shaped, ...passthroughArgs);
  }
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }
  wrapStreamResult(wrapper: unknown): unknown {
    return wrapper;
  }
}

describe("SolwynCore — streaming success latency includes establishment (F18)", () => {
  afterEach(() => {
    __resetAdapterRegistry();
  });

  it("measures streaming latency from dispatch start (includes establishment), not wrapper construction", async () => {
    __setAdapterLoadersForTesting({
      openai: async () =>
        new RegionStreamingAdapter(
          "us-east-1",
          createTokenDetails({ input_tokens: 5, output_tokens: 7 }),
        ),
    });
    async function* fast(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "x" } }] };
    }
    // ~30ms establishment delay, then an instantly-draining stream.
    const client = openAIClient(async () => {
      await sleep(30);
      return fast();
    });
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // drain (instant)
    }
    await solwyn.close();

    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("success");
    expect(event.provider_region).toBe("us-east-1");
    // Establishment (~30ms) is included. Wrapper-construction-relative timing (the old
    // behavior) would be only the sub-millisecond drain — well under this floor.
    expect(event.latency_ms).toBeGreaterThanOrEqual(15);
  });
});

describe("SolwynCore — mid-stream error event (F9)", () => {
  afterEach(() => {
    __resetAdapterRegistry();
  });

  it("sets possibly_succeeded=true, served region, measured latency, and NO failover_error_class", async () => {
    __setAdapterLoadersForTesting({
      openai: async () => new RegionStreamingAdapter("eu-west-1", zeroTokenDetails()),
    });
    const drop = new ProviderBoom();
    async function* yieldThenThrow(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "hi" } }] };
      await sleep(10);
      throw drop;
    }
    const client = openAIClient(() => yieldThenThrow());
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;

    await expect(
      (async () => {
        for await (const _chunk of stream) {
          // consume until the inner stream drops mid-flight
        }
      })(),
    ).rejects.toBe(drop);
    await solwyn.close();

    expect(ingested).toHaveLength(1);
    const event = ingested[0] as WireEvent;
    expect(event.status).toBe("error");
    // The sole possibly_succeeded=true case: billed-but-unconfirmed spend to reconcile.
    expect(event.possibly_succeeded).toBe(true);
    // Served hop's region rides through (needed for reconciliation).
    expect(event.provider_region).toBe("eu-west-1");
    // Mid-stream errors never fail over → no health-signal class name.
    expect("failover_error_class" in event).toBe(false);
    expect(event.latency_ms).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// reporterFlushInterval is measured in seconds, pinning the seconds-to-milliseconds bridge.
// ---------------------------------------------------------------------------

describe("SolwynCore — reporterFlushInterval unit is seconds (F20)", () => {
  it("interprets reporterFlushInterval as seconds: value 2 flushes near 2000ms, not 2ms", async () => {
    vi.useFakeTimers();
    try {
      const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      const { fetchMock, ingested } = makeFetch();
      const solwyn = new Solwyn(client, {
        apiKey: API_KEY,
        fetch: fetchMock,
        reporterFlushInterval: 2,
      });

      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });

      // Well past 2ms but before 2000ms: NOT flushed — proves the value is not consumed
      // as raw milliseconds (2ms would already have fired the background loop).
      await vi.advanceTimersByTimeAsync(500);
      expect(ingested).toHaveLength(0);

      // Crossing ~2000ms (2 seconds) triggers the background flush.
      await vi.advanceTimersByTimeAsync(1600);
      expect(ingested).toHaveLength(1);

      // Stop the loop cleanly under fake timers.
      const closing = solwyn.close();
      await vi.advanceTimersByTimeAsync(0);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});
