import { inspect } from "node:util";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ConfigurationError, Solwyn } from "../../src/index";
import { __resetAdapterRegistry, __setAdapterLoadersForTesting } from "../../src/providers/index";
import { buildRuntimes } from "../../src/registry";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const CUSTOM_INSPECT = Symbol.for("nodejs.util.inspect.custom");

class FakeOpenAI {
  readonly chat = {
    completions: {
      create: (_kwargs?: unknown) => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    },
  };

  ping(): string {
    return "pong";
  }
}

function noNetworkFetch(): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 })),
  );
}

async function closeUnexpected(value: unknown): Promise<void> {
  if (
    typeof value === "object" &&
    value !== null &&
    "close" in value &&
    typeof (value as { close?: unknown }).close === "function"
  ) {
    await (value as { close(): Promise<void> }).close();
  }
}

afterEach(() => {
  __resetAdapterRegistry();
});

describe("Solwyn wrapper type transparency", () => {
  it("returns the provider constructor raw with its original identity and name", async () => {
    const provider = new FakeOpenAI();
    const wrapper = new Solwyn(provider, { apiKey: API_KEY, fetch: noNetworkFetch() });

    expect(wrapper.constructor).toBe(FakeOpenAI);
    expect(wrapper.constructor.name).toBe("FakeOpenAI");
    await wrapper.close();
  });

  it("is simultaneously a provider instance and a branded Solwyn instance", async () => {
    const provider = new FakeOpenAI();
    const wrapper = new Solwyn(provider, { apiKey: API_KEY, fetch: noNetworkFetch() });

    expect(wrapper instanceof FakeOpenAI).toBe(true);
    expect(wrapper instanceof Solwyn).toBe(true);
    expectTypeOf(Solwyn[Symbol.hasInstance]).toBeFunction();
    await wrapper.close();
  });

  it("passes a framework-style provider gate without changing wrapper identity", async () => {
    const provider = new FakeOpenAI();
    const wrapper = new Solwyn(provider, { apiKey: API_KEY, fetch: noNetworkFetch() });
    const frameworkGate = (candidate: unknown): FakeOpenAI => {
      if (!(candidate instanceof FakeOpenAI)) {
        throw new TypeError("framework requires FakeOpenAI");
      }
      return candidate;
    };

    expect(frameworkGate(wrapper)).toBe(wrapper);
    expect(frameworkGate(wrapper) instanceof Solwyn).toBe(true);
    await wrapper.close();
  });

  it("uses the core-owned custom inspect hook and the callback Node provides", async () => {
    class InspectableOpenAI extends FakeOpenAI {
      [CUSTOM_INSPECT](): string {
        return "InspectableOpenAI(provider)";
      }
    }
    const provider = new InspectableOpenAI();
    const wrapper = new Solwyn(provider, { apiKey: API_KEY, fetch: noNetworkFetch() });
    const hook = (wrapper as unknown as Record<PropertyKey, unknown>)[CUSTOM_INSPECT];

    expect(inspect(wrapper)).toBe("Solwyn(InspectableOpenAI(provider))");
    expect(typeof hook).toBe("function");
    expect(
      (
        hook as (
          depth: number,
          options: unknown,
          inspectValue: (value: unknown) => string,
        ) => string
      )(2, {}, (value) => (value === provider ? "provider-via-callback" : "unexpected")),
    ).toBe("Solwyn(provider-via-callback)");
    await wrapper.close();
  });

  it("rejects a branded primary synchronously before override detection or I/O", async () => {
    const provider = new FakeOpenAI();
    const fetchMock = noNetworkFetch();
    const wrapped = new Solwyn(provider, { apiKey: API_KEY, fetch: fetchMock });
    const loader = vi.fn(async () => {
      throw new Error("adapter detection must not run");
    });
    __setAdapterLoadersForTesting({ openai: loader });
    let unexpected: unknown;
    let caught: unknown;

    try {
      unexpected = new Solwyn(wrapped, {
        apiKey: API_KEY,
        provider: "openai",
        fetch: fetchMock,
      });
    } catch (error) {
      caught = error;
    }
    await closeUnexpected(unexpected);

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({
      message: "client is already wrapped by Solwyn — pass the raw provider client",
      field: "client",
    });
    expect(loader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it("rejects a branded fallback synchronously before primary detection or I/O", async () => {
    const fallbackProvider = new FakeOpenAI();
    const fetchMock = noNetworkFetch();
    const wrappedFallback = new Solwyn(fallbackProvider, {
      apiKey: API_KEY,
      fetch: fetchMock,
    });
    const loader = vi.fn(async () => {
      throw new Error("adapter detection must not run");
    });
    __setAdapterLoadersForTesting({ openai: loader });
    let unexpected: unknown;
    let caught: unknown;

    try {
      unexpected = new Solwyn(new FakeOpenAI(), {
        apiKey: API_KEY,
        provider: "openai",
        fallback: [[wrappedFallback, "gpt-fallback"]],
        fetch: fetchMock,
      });
    } catch (error) {
      caught = error;
    }
    await closeUnexpected(unexpected);

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({
      message: "client is already wrapped by Solwyn — pass the raw provider client",
      field: "client",
    });
    expect(loader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await wrappedFallback.close();
  });

  it("defensively rejects a branded direct-registry client before override lookup", async () => {
    const fetchMock = noNetworkFetch();
    const wrapped = new Solwyn(new FakeOpenAI(), { apiKey: API_KEY, fetch: fetchMock });
    const loader = vi.fn(async () => {
      throw new Error("adapter lookup must not run");
    });
    __setAdapterLoadersForTesting({ openai: loader });

    await expect(
      buildRuntimes(wrapped, "gpt-primary", [], { primaryProvider: "openai" }),
    ).rejects.toMatchObject({
      message: "client is already wrapped by Solwyn — pass the raw provider client",
      field: "client",
    });
    expect(loader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it("keeps a malformed fallback on the fallback-spec validation path at construction", () => {
    const fetchMock = noNetworkFetch();
    let caught: unknown;
    try {
      new Solwyn(new FakeOpenAI(), {
        apiKey: API_KEY,
        fallback: [{ client: new FakeOpenAI(), model: "gpt-fallback" }] as unknown as [],
        fetch: fetchMock,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({ field: "fallback_specs" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
