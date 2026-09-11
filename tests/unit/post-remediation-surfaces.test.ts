import { afterEach, describe, expect, it, vi } from "vitest";
import { coverage, Solwyn, SolwynError, UntrackedSpendSurfaceError } from "../../src/index";
import {
  applySurfacePosture,
  effectiveSurfaceDecision,
  SurfaceObservationRegistry,
  SurfaceWarnOnceLatch,
} from "../../src/surface-guard";
import { createSurfaceRules } from "../../src/surfaces";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const clients: Array<{ close(): Promise<void> }> = [];

function fixture(posture: "warn" | "raise" | "allow", nested: boolean) {
  let approvedCalls = 0;
  let forbiddenCalls = 0;
  const resource = {
    approved: () => {
      approvedCalls += 1;
    },
    sibling: () => {
      forbiddenCalls += 1;
    },
  };
  const raw = {
    chat: { completions: { create() {} } },
    future: nested ? { child: resource } : resource,
  };
  const wrapped = new Solwyn(raw, {
    apiKey: API_KEY,
    onUnmetered: posture,
    acknowledgeUntracked: [nested ? "future.child.approved" : "future.approved"],
    reportUntrackedSurfaces: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  clients.push(wrapped);
  const parent: object = nested ? Reflect.get(wrapped, "future") : wrapped;
  const key = nested ? "child" : "future";
  const unguardable = () => {
    forbiddenCalls += 1;
  };
  return {
    raw,
    wrapped,
    parent,
    key,
    resource,
    unguardable,
    counts: () => ({ approvedCalls, forbiddenCalls }),
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe.each([false, true])("descendant acknowledgments nested=%s", (nested) => {
  describe.each(["warn", "raise", "allow"] as const)("%s posture", (posture) => {
    it.each([
      "set",
      "defineProperty",
      "accessor",
    ] as const)("refuses a callable ancestor after %s through reads and descriptors", (mutation) => {
      const { parent, key, unguardable, counts } = fixture(posture, nested);
      Reflect.get(Reflect.get(parent, key), "approved")();
      expect(counts().approvedCalls).toBe(1);
      if (mutation === "set") expect(Reflect.set(parent, key, unguardable)).toBe(true);
      else if (mutation === "defineProperty") {
        Object.defineProperty(parent, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: unguardable,
        });
      } else {
        Object.defineProperty(parent, key, {
          configurable: true,
          enumerable: true,
          get: () => unguardable,
        });
      }
      expect(() => Reflect.get(parent, key)()).toThrow(SolwynError);
      expect(() => {
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        const result =
          descriptor && ("value" in descriptor ? descriptor.value : descriptor.get?.());
        if (typeof result === "function") result();
      }).toThrow(SolwynError);
      expect(counts().forbiddenCalls).toBe(0);
    });
  });

  it("preserves guarded accessor traversal until its live value becomes callable", () => {
    const { parent, key, resource, unguardable, counts } = fixture("raise", nested);
    let current: object = resource;
    Object.defineProperty(parent, key, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value: object) => {
        current = value;
      },
    });
    Reflect.get(Reflect.get(parent, key), "approved")();
    expect(() => Reflect.get(Reflect.get(parent, key), "sibling")()).toThrow(
      UntrackedSpendSurfaceError,
    );
    const descriptor = Object.getOwnPropertyDescriptor(parent, key);
    Reflect.get(descriptor?.get?.(), "approved")();
    descriptor?.set?.(unguardable);
    expect(() => Reflect.get(parent, key)()).toThrow(SolwynError);
    expect(() => descriptor?.get?.()).toThrow(SolwynError);
    expect(counts()).toEqual({ approvedCalls: 2, forbiddenCalls: 0 });
  });
});

it.each([
  "warn",
  "raise",
  "allow",
] as const)("coverage refuses an unguardable descendant prefix under %s", (posture) => {
  const { wrapped, unguardable } = fixture(posture, false);
  Reflect.set(wrapped, "future", unguardable);
  const entry = coverage(wrapped).entries.find((candidate) => candidate.surface === "future");
  expect(entry).toMatchObject({
    kind: "unknown",
    observedReturnShape: "function",
    dispatchAction: "refuse",
  });
});

it("preserves exact terminal and reviewed raw-response acknowledgments", () => {
  const operation = vi.fn(() => undefined);
  const raw = { chat: { completions: { create() {} } }, future: operation };
  const wrapped = new Solwyn(raw, {
    apiKey: API_KEY,
    onUnmetered: "raise",
    acknowledgeUntracked: ["future"],
    reportUntrackedSurfaces: false,
  });
  clients.push(wrapped);
  Reflect.get(wrapped, "future")();
  expect(operation).toHaveBeenCalledTimes(1);
  const [rule] = createSurfaceRules([
    {
      ruleId: "surface.raw-response.unmetered_spend",
      surface: "rawResponse",
      selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
      kind: "unmetered_spend",
      source: "raw",
      expectedShapes: [{ descriptorCategory: "field", returnShape: "resource" }],
      acknowledgmentToken: "rawResponse",
      capabilityScope: "raw_response",
    },
  ]);
  const value = { operation };
  const guard = vi.fn(() => {
    throw new Error("exact raw response must remain raw");
  });
  expect(
    applySurfacePosture({
      posture: "raise",
      decision: effectiveSurfaceDecision(
        { path: "rawResponse", descriptorCategory: "field", returnShape: "resource" },
        rule,
      ),
      provider: "openai",
      clientShape: "openai_sdk",
      acknowledgments: ["rawResponse"],
      registry: new SurfaceObservationRegistry(),
      warningLatch: new SurfaceWarnOnceLatch(),
      guardAcknowledgedDescendant: guard,
      execute: () => value,
    }),
  ).toBe(value);
  expect(guard).not.toHaveBeenCalled();
});
