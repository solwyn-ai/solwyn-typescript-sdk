import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetUnmeteredSurfaceWarnings } from "../../src/client";
import { ConfigurationError, coverage, Solwyn, UntrackedSpendSurfaceError } from "../../src/index";
import { noopLogger } from "../../src/logging";

const clients: Array<{ close(): Promise<void> }> = [];
const apiKey = `sk_proj_${"a".repeat(64)}`;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  __resetUnmeteredSurfaceWarnings();
});

describe.each([
  "warn",
  "allow",
  "raise",
] as const)("resource reflection under %s", (onUnmetered) => {
  it("preserves real OpenAI and Anthropic resource metadata and formatting", async () => {
    const options = {
      apiKey,
      onUnmetered,
      logger: noopLogger,
      reportUntrackedSurfaces: false,
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    };
    const oa = new Solwyn(new OpenAI({ apiKey: "offline" }), options);
    const an = new Solwyn(new Anthropic({ apiKey: "offline" }), options);
    clients.push(oa, an);
    expect(Reflect.get(oa.models, "_client")).toBeDefined();
    expect(Object.keys(oa.models)).toEqual(Object.keys(new OpenAI({ apiKey: "offline" }).models));
    expect(() => ({ ...oa.batches })).not.toThrow();
    // Native resources contain a cycle through _client; preserve that native error.
    expect(() => JSON.stringify(new OpenAI({ apiKey: "offline" }))).toThrow(/circular/i);
    expect(() => JSON.stringify(oa)).toThrow(/circular/i);
    expect(() => `${oa.batches}`).not.toThrow();
    expect(() => String(an.beta)).not.toThrow();
    expect(Object.prototype.toString.call(oa.files)).toBe("[object Object]");
    expect(() => JSON.stringify(new Anthropic({ apiKey: "offline" }))).toThrow(/circular/i);
    if (onUnmetered !== "raise") expect(() => JSON.stringify(an)).toThrow(/circular/i);
    await Promise.resolve();
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("does not count descriptor, key, or membership inspection as surface use", async () => {
    const warn = vi.fn();
    const operation = vi.fn(() => "synthetic");
    const raw = { chat: { completions: { create() {} } }, models: { list: operation } };
    const wrapped = new Solwyn(raw, {
      apiKey,
      onUnmetered,
      reportUntrackedSurfaces: false,
      logger: { ...noopLogger, warn },
    });
    clients.push(wrapped);
    const resource = wrapped.models;
    expect(Object.keys(resource)).toEqual(["list"]);
    expect("list" in resource).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(resource, "list");
    expect(descriptor?.value).toBeTypeOf("function");
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    if (onUnmetered === "raise") {
      expect(() => descriptor?.value()).toThrow(UntrackedSpendSurfaceError);
    } else {
      expect(descriptor?.value()).toBe("synthetic");
    }
  });
});

it("records the used terminal method without recording its container", async () => {
  const warn = vi.fn();
  const wrapped = new Solwyn(
    { chat: { completions: { create() {} } }, models: { list: () => "synthetic" } },
    { apiKey, logger: { ...noopLogger, warn }, reportUntrackedSurfaces: false },
  );
  clients.push(wrapped);
  for (let i = 0; i < 4; i++) wrapped.models.list();
  await Promise.resolve();
  const shared = Reflect.get(globalThis, Symbol.for("@solwyn/sdk.surfacePosture.v1"));
  expect(
    shared.observations.snapshot().map((entry: { surface: string; count: number }) => ({
      surface: entry.surface,
      count: entry.count,
    })),
  ).toEqual([{ surface: "models.list", count: 4 }]);
  expect(warn).toHaveBeenCalledTimes(1);
});

it("records a terminal namespace read after traversal has had a chance to occur", async () => {
  const warn = vi.fn();
  const wrapped = new Solwyn(
    { chat: { completions: { create() {} } }, models: { list() {} } },
    { apiKey, logger: { ...noopLogger, warn }, reportUntrackedSurfaces: false },
  );
  clients.push(wrapped);
  void wrapped.models;
  await Promise.resolve();
  expect(warn).toHaveBeenCalledWith(expect.any(String), "openai", "openai_sdk", "models", null);
});

it("memoizes surface attribution reads and refreshes after proxy mutation", () => {
  let inspections = 0;
  const raw = new Proxy(
    { baseURL: "https://api.openai.com/v1", timeout: 10, chat: { completions: { create() {} } } },
    {
      getPrototypeOf(target) {
        inspections++;
        return Reflect.getPrototypeOf(target);
      },
    },
  );
  const wrapped = new Solwyn(raw, { apiKey, logger: noopLogger, reportUntrackedSurfaces: false });
  clients.push(wrapped);
  expect(wrapped.timeout).toBe(10);
  const before = inspections;
  for (let i = 0; i < 20; i++) expect(wrapped.timeout).toBe(10);
  expect(inspections - before).toBeLessThan(30);
  wrapped.baseURL = "https://api.groq.com/openai/v1";
  expect(coverage(wrapped).providerChain[0]?.provider).toBe("groq");
});

it("keeps incompatible provider-shape mutations invalid on repeated reads", () => {
  const wrapped = new Solwyn(
    { timeout: 10, chat: { completions: { create() {} } } },
    {
      apiKey,
      logger: noopLogger,
      reportUntrackedSurfaces: false,
    },
  );
  clients.push(wrapped);
  Reflect.set(wrapped, "messages", { create() {} });
  Reflect.deleteProperty(wrapped, "chat");
  for (let i = 0; i < 2; i++) expect(() => wrapped.timeout).toThrow(ConfigurationError);
});

it("throws a typed configuration error for unregistered coverage objects", () => {
  expect(() => coverage({})).toThrow(ConfigurationError);
});

it("forwards reflected resource mutations with the native private-field receiver", () => {
  class Resource {
    #setting = 0;
    set setting(value: number) {
      this.#setting = value;
    }
    current() {
      return this.#setting;
    }
  }
  const models = new Resource();
  const wrapped = new Solwyn(
    { chat: { completions: { create() {} } }, models },
    {
      apiKey,
      onUnmetered: "raise",
      logger: noopLogger,
      reportUntrackedSurfaces: false,
    },
  );
  clients.push(wrapped);
  const reflected = Object.getOwnPropertyDescriptor(wrapped, "models")?.value;
  expect(Reflect.set(reflected, "setting", 2, {})).toBe(true);
  expect(models.current()).toBe(2);
  expect(Reflect.defineProperty(reflected, "added", { configurable: true, value: 3 })).toBe(true);
  expect(Reflect.get(models, "added")).toBe(3);
  expect(Reflect.deleteProperty(reflected, "added")).toBe(true);
  expect(Reflect.has(models, "added")).toBe(false);
});
