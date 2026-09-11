import { describe, expect, it, vi } from "vitest";
import { SolwynError, UntrackedSpendSurfaceError } from "../../src/errors";
import {
  applySurfacePosture,
  type EffectiveSurfaceDecision,
  effectiveSurfaceDecision,
  SurfaceNamespaceGuardCache,
  SurfaceObservationRegistry,
  type SurfaceReadGuard,
  SurfaceWarnOnceLatch,
} from "../../src/surface-guard";
import { createSurfaceRules, type SurfaceContext } from "../../src/surfaces";

const OPENAI: SurfaceContext = {
  provider: "openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};

function unknownDecision(surface = "future.create"): EffectiveSurfaceDecision {
  return effectiveSurfaceDecision({
    path: surface,
    descriptorCategory: "method",
    returnShape: "function",
  });
}

function unmeteredDecision(surface = "widgets.create"): EffectiveSurfaceDecision {
  const [rule] = createSurfaceRules([
    {
      ruleId: `surface.${surface.replaceAll(".", "-")}.unmetered_spend`,
      surface,
      selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
      kind: "unmetered_spend",
      source: "raw",
      expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
      acknowledgmentToken: surface,
      capabilityScope: "operation",
    },
  ]);
  return effectiveSurfaceDecision(
    { path: surface, descriptorCategory: "method", returnShape: "function" },
    rule,
  );
}

function unmeteredResourceDecision(
  surface: string,
  capabilityScope: "resource" | "raw_response" = "resource",
): EffectiveSurfaceDecision {
  const [rule] = createSurfaceRules([
    {
      ruleId: `surface.${surface.replaceAll(".", "-")}.unmetered_spend`,
      surface,
      selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
      kind: "unmetered_spend",
      source: "raw",
      expectedShapes: [{ descriptorCategory: "field", returnShape: "resource" }],
      acknowledgmentToken: surface,
      capabilityScope,
    },
  ]);
  return effectiveSurfaceDecision(
    { path: surface, descriptorCategory: "field", returnShape: "resource" },
    rule,
  );
}

function driftedResourceDecision(surface: string): EffectiveSurfaceDecision {
  const [rule] = createSurfaceRules([
    {
      ruleId: `surface.${surface.replaceAll(".", "-")}.unmetered_spend`,
      surface,
      selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
      kind: "unmetered_spend",
      source: "raw",
      expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
      acknowledgmentToken: surface,
      capabilityScope: "raw_response",
    },
  ]);
  return effectiveSurfaceDecision(
    { path: surface, descriptorCategory: "field", returnShape: "resource" },
    rule,
  );
}

describe("effectiveSurfaceDecision", () => {
  it("uses an accepting authored rule and turns absent or drifted shapes into local unknown", () => {
    const [rule] = createSurfaceRules([
      {
        ruleId: "surface.widgets-create.unmetered_spend",
        surface: "widgets.create",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "unmetered_spend",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        acknowledgmentToken: "widgets.create",
        capabilityScope: "operation",
      },
    ]);

    expect(
      effectiveSurfaceDecision(
        { path: "widgets.create", descriptorCategory: "method", returnShape: "function" },
        rule,
      ),
    ).toMatchObject({
      surface: "widgets.create",
      kind: "unmetered_spend",
      acknowledgmentToken: "widgets.create",
      capabilityScope: "operation",
      observedReturnShape: "function",
      driftedFromRuleId: null,
      rule,
    });
    expect(
      effectiveSurfaceDecision(
        { path: "widgets.create", descriptorCategory: "field", returnShape: "scalar" },
        rule,
      ),
    ).toMatchObject({
      surface: "widgets.create",
      kind: "unknown",
      acknowledgmentToken: "widgets.create",
      capabilityScope: null,
      observedReturnShape: "scalar",
      driftedFromRuleId: "surface.widgets-create.unmetered_spend",
      rule: null,
    });
    expect(unknownDecision()).toMatchObject({
      surface: "future.create",
      kind: "unknown",
      acknowledgmentToken: "future.create",
      capabilityScope: null,
      observedReturnShape: "function",
      driftedFromRuleId: null,
      rule: null,
    });
  });
});

describe("SurfaceObservationRegistry", () => {
  it("counts structural observations and retains existing keys when saturated", () => {
    const registry = new SurfaceObservationRegistry(2);
    const first = {
      provider: "openai",
      clientShape: "openai_sdk" as const,
      decision: unknownDecision("first.create"),
    };
    registry.record({ ...first, observedAt: 20 });
    registry.record({ ...first, observedAt: 10 });
    registry.record({ ...first, decision: unknownDecision("second.create"), observedAt: 30 });
    expect(
      registry.record({ ...first, decision: unknownDecision("third.create"), observedAt: 40 }),
    ).toBeUndefined();

    expect(registry.size).toBe(2);
    expect(registry.get("openai", "openai_sdk", "first.create")).toMatchObject({
      count: 2,
      firstObservedAt: 10,
      lastObservedAt: 20,
    });
    expect(registry.snapshot().map(({ surface }) => surface)).toEqual([
      "first.create",
      "second.create",
    ]);
    expect(Object.isFrozen(registry.snapshot())).toBe(true);
  });

  it("keeps identifier-clean over-wire paths local and clamps the default registry to 512 keys", () => {
    const registry = new SurfaceObservationRegistry();
    const longSurface = "x".repeat(129);
    registry.record({
      provider: "openai",
      clientShape: "openai_sdk",
      decision: unknownDecision(longSurface),
      observedAt: 1,
    });
    for (let index = 0; index < 512; index += 1) {
      registry.record({
        provider: "openai",
        clientShape: "openai_sdk",
        decision: unknownDecision(`surface${index}`),
        observedAt: index + 2,
      });
    }

    expect(registry.size).toBe(512);
    expect(registry.get("openai", "openai_sdk", longSurface)).toBeDefined();
    expect(registry.get("openai", "openai_sdk", "surface510")).toBeDefined();
    expect(registry.get("openai", "openai_sdk", "surface511")).toBeUndefined();
  });
});

describe("SurfaceWarnOnceLatch", () => {
  it("keys warnings by the exact provider, client shape, and surface tuple", () => {
    const latch = new SurfaceWarnOnceLatch();
    expect(latch.shouldWarn("openai", "openai_sdk", "future.create")).toBe(true);
    expect(latch.shouldWarn("openai", "openai_sdk", "future.create")).toBe(false);
    expect(latch.shouldWarn("groq", "openai_sdk", "future.create")).toBe(true);
    expect(latch.shouldWarn("openai", "undeclared_sdk", "future.create")).toBe(true);
    expect(latch.shouldWarn("openai", "openai_sdk", "future.parse")).toBe(true);
  });
});

describe("applySurfacePosture", () => {
  it("raises before executing or recording/reporting an unacknowledged surface", () => {
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const execute = vi.fn(() => "paid result");
    const report = vi.fn();
    const logger = { warn: vi.fn() };

    expect(() =>
      applySurfacePosture({
        posture: "raise",
        decision: unknownDecision(),
        provider: "openai",
        clientShape: "openai_sdk",
        acknowledgments: [],
        registry,
        warningLatch,
        report,
        logger,
        observedAt: () => 1,
        execute,
      }),
    ).toThrow(UntrackedSpendSurfaceError);
    expect(execute).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  it("warns once even when the logger throws, while recording/reporting every execution", () => {
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const report = vi.fn();
    const logger = {
      warn: vi.fn(() => {
        throw new Error("logger failed");
      }),
    };
    const execute = vi.fn(() => "result");
    const options = {
      posture: "warn" as const,
      decision: unknownDecision(),
      provider: "openai",
      clientShape: "openai_sdk" as const,
      acknowledgments: [] as const,
      registry,
      warningLatch,
      report,
      logger,
      observedAt: () => 5,
      execute,
    };

    expect(applySurfacePosture(options)).toBe("result");
    expect(applySurfacePosture(options)).toBe("result");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider '%s' client shape '%s' exposes untracked surface '%s' (scope: %s); no budget check and no cost event will be emitted. Tracking for this surface is coming.",
      "openai",
      "openai_sdk",
      "future.create",
      null,
    );
    expect(report).toHaveBeenCalledTimes(2);
    expect(registry.get("openai", "openai_sdk", "future.create")?.count).toBe(2);
  });

  it("treats allow as a silent local observation and advisory-report path", () => {
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const report = vi.fn();
    const logger = { warn: vi.fn() };
    const execute = vi.fn(() => 7);
    const common = {
      decision: unknownDecision(),
      provider: "openai",
      clientShape: "openai_sdk" as const,
      registry,
      warningLatch,
      report,
      logger,
      observedAt: () => 10,
      execute,
    };

    expect(applySurfacePosture({ ...common, posture: "allow", acknowledgments: [] })).toBe(7);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(registry.get("openai", "openai_sdk", "future.create")?.count).toBe(1);
  });

  it.each([
    ["unknown", unknownDecision()],
    ["unmetered", unmeteredDecision()],
  ])("returns an acknowledged %s decision before every local side effect", (_kind, decision) => {
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const report = vi.fn();
    const logger = { warn: vi.fn() };
    const observedAt = vi.fn(() => 10);
    const execute = vi.fn(() => 7);

    expect(
      applySurfacePosture({
        posture: "raise",
        decision,
        provider: "openai",
        clientShape: "openai_sdk",
        acknowledgments: [decision.acknowledgmentToken],
        registry,
        warningLatch,
        report,
        logger,
        observedAt,
        execute,
      }),
    ).toBe(7);
    expect(execute).toHaveBeenCalledOnce();
    expect(observedAt).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  it("lets an exact acknowledged descendant traverse its unknown parent only through a guard", () => {
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const cache = new SurfaceNamespaceGuardCache();
    const acknowledgments = ["future.create"];
    let siblingReads = 0;
    const raw = Object.defineProperty(
      {
        create() {
          return "created";
        },
      },
      "sibling",
      {
        get() {
          siblingReads += 1;
          return "untracked";
        },
      },
    ) as { create(): string; readonly sibling: string };
    const guardValue = (surface: string, value: unknown): unknown => {
      if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        throw new Error("acknowledged descendant has unguardable prefix");
      }
      return cache.getOrCreate(value, surface, OPENAI, readGuard);
    };
    const readGuard: SurfaceReadGuard = (surface, execute) =>
      applySurfacePosture({
        posture: "raise",
        decision: unknownDecision(surface),
        provider: "openai",
        clientShape: "openai_sdk",
        acknowledgments,
        registry,
        warningLatch,
        guardAcknowledgedDescendant: (value) => guardValue(surface, value),
        execute,
      });

    const guarded = applySurfacePosture({
      posture: "raise",
      decision: effectiveSurfaceDecision({
        path: "future",
        descriptorCategory: "field",
        returnShape: "resource",
      }),
      provider: "openai",
      clientShape: "openai_sdk",
      acknowledgments,
      registry,
      warningLatch,
      guardAcknowledgedDescendant: (value) => guardValue("future", value) as typeof raw,
      execute: () => raw,
    }) as typeof raw;

    expect(Object.is(guarded, raw)).toBe(false);
    expect(guarded.create()).toBe("created");
    expect(() => guarded.sibling).toThrow(UntrackedSpendSurfaceError);
    expect(siblingReads).toBe(0);
    expect(registry.size).toBe(0);
  });

  it("keeps an exact terminal acknowledgment raw instead of invoking the descendant guard", () => {
    const terminal = Object.freeze({ status: "raw" });
    const guardAcknowledgedDescendant = vi.fn((value: unknown) => value);

    expect(
      applySurfacePosture({
        posture: "raise",
        decision: unknownDecision("future.create"),
        provider: "openai",
        clientShape: "openai_sdk",
        acknowledgments: ["future.create"],
        registry: new SurfaceObservationRegistry(),
        warningLatch: new SurfaceWarnOnceLatch(),
        guardAcknowledgedDescendant,
        execute: () => terminal,
      }),
    ).toBe(terminal);
    expect(guardAcknowledgedDescendant).not.toHaveBeenCalled();
  });

  it("fails closed when descendant traversal has no guard seam", () => {
    const execute = vi.fn(() => ({ create() {} }));

    expect(() =>
      applySurfacePosture({
        posture: "raise",
        decision: effectiveSurfaceDecision({
          path: "future",
          descriptorCategory: "field",
          returnShape: "resource",
        }),
        provider: "openai",
        clientShape: "openai_sdk",
        acknowledgments: ["future.create"],
        registry: new SurfaceObservationRegistry(),
        warningLatch: new SurfaceWarnOnceLatch(),
        execute,
      }),
    ).toThrow("acknowledged descendant requires a namespace guard");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps an exactly acknowledged provisional resource guarded without posture effects", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const raw = {
      create() {
        return "allowed";
      },
      sibling: "refused",
    };
    const guard = (value: typeof raw) =>
      cache.getOrCreate(value, "future", OPENAI, (surface, execute) =>
        applySurfacePosture({
          posture: "raise",
          decision: unknownDecision(surface),
          provider: "openai",
          clientShape: "openai_sdk",
          acknowledgments: ["future"],
          registry,
          warningLatch,
          execute,
        }),
      );
    const common = {
      posture: "raise" as const,
      decision: effectiveSurfaceDecision({
        path: "future",
        descriptorCategory: "field",
        returnShape: "resource",
      }),
      provider: "openai",
      clientShape: "openai_sdk" as const,
      acknowledgments: ["future"],
      registry,
      warningLatch,
      guardAcknowledgedDescendant: guard,
      execute: () => raw,
    };

    const first = applySurfacePosture(common);
    const second = applySurfacePosture(common);

    expect(first).toBe(second);
    expect(() => first.sibling).toThrow(UntrackedSpendSurfaceError);
    expect(registry.size).toBe(0);
  });

  it("keeps an exactly acknowledged reviewed resource behind the guard seam", () => {
    const raw = { child: "protected" };
    const guardAcknowledgedDescendant = vi.fn((value: typeof raw) => ({ ...value, guarded: true }));

    expect(
      applySurfacePosture({
        posture: "raise",
        decision: unmeteredResourceDecision("widgets"),
        provider: "openai",
        clientShape: "openai_sdk",
        acknowledgments: ["widgets"],
        registry: new SurfaceObservationRegistry(),
        warningLatch: new SurfaceWarnOnceLatch(),
        guardAcknowledgedDescendant,
        execute: () => raw,
      }),
    ).toEqual({ child: "protected", guarded: true });
    expect(guardAcknowledgedDescendant).toHaveBeenCalledOnce();
  });

  it("returns raw only for an exact accepted raw-response token", () => {
    const raw = { result: "raw" };
    const guardAcknowledgedDescendant = vi.fn(
      (value: typeof raw): typeof raw => new Proxy(value, {}),
    );
    const decision = unmeteredResourceDecision("responses.create", "raw_response");
    const common = {
      posture: "allow" as const,
      decision,
      provider: "openai",
      clientShape: "openai_sdk" as const,
      registry: new SurfaceObservationRegistry(),
      warningLatch: new SurfaceWarnOnceLatch(),
      guardAcknowledgedDescendant,
      execute: () => raw,
    };

    expect(applySurfacePosture({ ...common, acknowledgments: ["responses.create"] })).toBe(raw);
    expect(applySurfacePosture({ ...common, acknowledgments: [] })).not.toBe(raw);
    expect(
      applySurfacePosture({ ...common, acknowledgments: ["responses.create.child"] }),
    ).not.toBe(raw);
    expect(guardAcknowledgedDescendant).toHaveBeenCalledTimes(2);
  });

  it("does not honor an exact token after shape drift", () => {
    const decision = driftedResourceDecision("responses.create");
    const execute = vi.fn(() => ({ guarded: false }));
    const guardAcknowledgedDescendant = vi.fn((value: { guarded: boolean }) => ({
      ...value,
      guarded: true,
    }));

    expect(() =>
      applySurfacePosture({
        posture: "raise",
        decision,
        provider: "openai",
        clientShape: "openai_sdk",
        acknowledgments: ["responses.create"],
        registry: new SurfaceObservationRegistry(),
        warningLatch: new SurfaceWarnOnceLatch(),
        guardAcknowledgedDescendant,
        execute,
      }),
    ).toThrow(UntrackedSpendSurfaceError);
    expect(execute).not.toHaveBeenCalled();

    for (const posture of ["warn", "allow"] as const) {
      const registry = new SurfaceObservationRegistry();
      expect(
        applySurfacePosture({
          posture,
          decision,
          provider: "openai",
          clientShape: "openai_sdk",
          acknowledgments: ["responses.create"],
          registry,
          warningLatch: new SurfaceWarnOnceLatch(),
          guardAcknowledgedDescendant,
          execute,
        }),
      ).toEqual({ guarded: true });
      expect(registry.snapshot()[0]).toMatchObject({ kind: "unknown", capabilityScope: null });
    }
  });

  it("names the reviewed rule in shape-drift warnings without exposing returned values", () => {
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const logger = { warn: vi.fn() };
    const report = vi.fn();
    const value = { privateValue: "SURFACE_VALUE_MUST_NOT_BE_LOGGED" };

    for (let index = 0; index < 2; index += 1) {
      expect(
        applySurfacePosture({
          posture: "warn",
          decision: driftedResourceDecision("responses.create"),
          provider: "openai",
          clientShape: "openai_sdk",
          registry,
          warningLatch,
          logger,
          report,
          guardAcknowledgedDescendant: (returned) => returned,
          execute: () => value,
        }),
      ).toBe(value);
    }

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "Provider '%s' client shape '%s' exposes untracked surface '%s' (scope: %s); no budget check and no cost event will be emitted. Tracking for this surface is coming. Reviewed rule surface.responses-create.unmetered_spend no longer matches its shape.",
      "openai",
      "openai_sdk",
      "responses.create",
      null,
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(value.privateValue);
    expect(report).toHaveBeenCalledTimes(2);
    expect(registry.snapshot()[0]).toMatchObject({
      count: 2,
      driftedFromRuleId: "surface.responses-create.unmetered_spend",
    });
  });

  it("fails closed on malformed paths and keeps wire-ineligible observations local", () => {
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const execute = vi.fn(() => true);
    const report = vi.fn();
    const logger = { warn: vi.fn() };
    const malformed = { ...unknownDecision(), surface: "bad-name" };

    expect(() =>
      applySurfacePosture({
        posture: "warn",
        decision: malformed,
        provider: "openai",
        clientShape: "openai_sdk",
        registry,
        warningLatch,
        report,
        logger,
        execute,
      }),
    ).toThrow("invalid public surface path");
    expect(execute).not.toHaveBeenCalled();

    const longSurface = "x".repeat(129);
    expect(
      applySurfacePosture({
        posture: "warn",
        decision: unknownDecision(longSurface),
        provider: "openai",
        clientShape: "openai_sdk",
        registry,
        warningLatch,
        report,
        logger,
        observedAt: () => 2,
        execute,
      }),
    ).toBe(true);
    expect(registry.get("openai", "openai_sdk", longSurface)?.count).toBe(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it.each([
    "x".repeat(129),
    "café",
  ])("omits wire-ineligible surface %s from warning arguments", (surface) => {
    const logger = { warn: vi.fn() };

    expect(
      applySurfacePosture({
        posture: "warn",
        decision: unknownDecision(surface),
        provider: "openai",
        clientShape: "openai_sdk",
        registry: new SurfaceObservationRegistry(),
        warningLatch: new SurfaceWarnOnceLatch(),
        logger,
        execute: () => true,
      }),
    ).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Provider '%s' client shape '%s' exposes an untracked public surface outside advisory reporting limits; no budget check and no cost event will be emitted, and no advisory report will be sent.",
      "openai",
      "openai_sdk",
    );
    expect(logger.warn.mock.calls.flat()).not.toContain(surface);
  });

  it("reports every origin observation but warns once when warn posture overflows the registry", () => {
    const registry = new SurfaceObservationRegistry(1);
    registry.record({
      provider: "openai",
      clientShape: "openai_sdk",
      decision: unknownDecision("existing.create"),
      observedAt: 1,
    });
    const warningLatch = new SurfaceWarnOnceLatch();
    const report = vi.fn();
    const logger = { warn: vi.fn() };
    const execute = vi.fn(() => true);

    expect(
      applySurfacePosture({
        posture: "warn",
        decision: unknownDecision("overflow.create"),
        provider: "openai",
        clientShape: "openai_sdk",
        registry,
        warningLatch,
        report,
        logger,
        observedAt: () => 2,
        execute,
      }),
    ).toBe(true);
    expect(
      applySurfacePosture({
        posture: "warn",
        decision: unknownDecision("laterOverflow.create"),
        provider: "openai",
        clientShape: "openai_sdk",
        registry,
        warningLatch,
        report,
        logger,
        observedAt: () => 3,
        execute,
      }),
    ).toBe(true);
    expect(registry.snapshot().map(({ surface }) => surface)).toEqual(["existing.create"]);
    expect(report).toHaveBeenCalledTimes(2);
    for (const [index, surface] of ["overflow.create", "laterOverflow.create"].entries()) {
      expect(report).toHaveBeenNthCalledWith(index + 1, {
        provider: "openai",
        clientShape: "openai_sdk",
        surface,
        kind: "unknown",
        capabilityScope: null,
        driftedFromRuleId: null,
        count: 1,
        firstObservedAt: index + 2,
        lastObservedAt: index + 2,
      });
      expect(Object.isFrozen(report.mock.calls[index]?.[0])).toBe(true);
    }
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "Untracked-surface warning limit (%d) reached; further distinct surfaces will not be individually reported this process.",
      1,
    );
  });

  it("reports origin observations silently when allow posture finds the registry saturated", () => {
    const registry = new SurfaceObservationRegistry(1);
    registry.record({
      provider: "openai",
      clientShape: "openai_sdk",
      decision: unknownDecision("existing.create"),
      observedAt: 1,
    });
    const logger = { warn: vi.fn() };
    const report = vi.fn();

    expect(
      applySurfacePosture({
        posture: "allow",
        decision: unknownDecision("overflow.create"),
        provider: "openai",
        clientShape: "openai_sdk",
        registry,
        warningLatch: new SurfaceWarnOnceLatch(),
        logger,
        report,
        observedAt: () => 2,
        execute: () => true,
      }),
    ).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      provider: "openai",
      clientShape: "openai_sdk",
      surface: "overflow.create",
      kind: "unknown",
      capabilityScope: null,
      driftedFromRuleId: null,
      count: 1,
      firstObservedAt: 2,
      lastObservedAt: 2,
    });
  });
});

describe("SurfaceNamespaceGuardCache", () => {
  it("keeps identity stable for repeated target/path/context keys", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const target = { value: 1 };
    const read = (_surface: string, execute: () => unknown) => execute();

    const first = cache.getOrCreate(target, "models", OPENAI, read);
    expect(cache.getOrCreate(target, "models", { ...OPENAI }, read)).toBe(first);
    expect(Object.is(cache.getOrCreate(target, "other", OPENAI, read), first)).toBe(false);
    expect(
      Object.is(
        cache.getOrCreate(target, "models", { ...OPENAI, provider: "azure_openai" }, read),
        first,
      ),
    ).toBe(false);
  });

  it("guards reads before getter evaluation while forwarding mutations directly", () => {
    const cache = new SurfaceNamespaceGuardCache();
    let getterReads = 0;
    const target: Record<string, unknown> = Object.defineProperty({ mutable: 1 }, "paid", {
      configurable: true,
      get() {
        getterReads += 1;
        return "paid";
      },
    });
    const registry = new SurfaceObservationRegistry();
    const warningLatch = new SurfaceWarnOnceLatch();
    const readGuard = (surface: string, execute: () => unknown) =>
      applySurfacePosture({
        posture: "raise",
        decision: unknownDecision(surface),
        provider: "openai",
        clientShape: "openai_sdk",
        registry,
        warningLatch,
        execute,
      });
    const guarded = cache.getOrCreate(target, "models", OPENAI, readGuard);

    expect(() => guarded["paid"]).toThrow(UntrackedSpendSurfaceError);
    expect(getterReads).toBe(0);

    guarded["mutable"] = 2;
    Object.defineProperty(guarded, "added", { configurable: true, value: 3 });
    expect(delete guarded["mutable"]).toBe(true);
    expect(target["added"]).toBe(3);
    expect("mutable" in target).toBe(false);
    expect(registry.size).toBe(0);
  });

  it.each([
    "data",
    "accessor",
  ] as const)("enforces strict posture on reflected configurable %s capabilities", (kind) => {
    let getterReads = 0;
    let operations = 0;
    const operation = () => {
      operations += 1;
    };
    const target = Object.defineProperty({}, "paid", {
      configurable: true,
      ...(kind === "data"
        ? { value: operation, writable: true }
        : {
            get() {
              getterReads += 1;
              return operation;
            },
          }),
    });
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(
      target,
      "models",
      OPENAI,
      (surface, execute) =>
        applySurfacePosture({
          posture: "raise",
          decision: unknownDecision(surface),
          provider: "openai",
          clientShape: "openai_sdk",
          registry: new SurfaceObservationRegistry(),
          warningLatch: new SurfaceWarnOnceLatch(),
          execute,
        }),
    );

    expect(() => {
      const descriptor = Object.getOwnPropertyDescriptor(guarded, "paid");
      const callable = kind === "data" ? descriptor?.value : descriptor?.get?.call(guarded);
      (callable as () => void)();
    }).toThrow(UntrackedSpendSurfaceError);
    expect(getterReads).toBe(0);
    expect(operations).toBe(0);
  });

  it.each([
    "data",
    "accessor",
  ] as const)("guards and binds reflected configurable %s capabilities", (kind) => {
    let getterReads = 0;
    let reads = 0;
    const target = { result: "provider result" };
    const operation = function (this: typeof target) {
      return this.result;
    };
    Object.defineProperty(target, "paid", {
      configurable: true,
      ...(kind === "data"
        ? { value: operation, writable: true }
        : {
            get() {
              getterReads += 1;
              return operation;
            },
          }),
    });
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(
      target,
      "models",
      OPENAI,
      (surface, execute) => {
        expect(surface).toBe("models.paid");
        reads += 1;
        return execute();
      },
    );

    const descriptor = Object.getOwnPropertyDescriptor(guarded, "paid");
    expect(getterReads).toBe(0);
    const callable = kind === "data" ? descriptor?.value : descriptor?.get?.call({});
    expect((callable as () => string)()).toBe("provider result");
    expect(reads).toBe(1);
    expect(getterReads).toBe(kind === "data" ? 0 : 1);
    expect(callable).toBe(Reflect.get(guarded, "paid"));
  });

  it.each([
    "getter-setter",
    "setter-only",
  ] as const)("binds reflected configurable %s mutations without entering strict read posture", (kind) => {
    let getterReads = 0;
    const result = { updated: true };
    class ProviderResource {
      #value = "before";

      constructor() {
        Object.defineProperty(this, "setting", {
          configurable: true,
          enumerable: true,
          ...(kind === "getter-setter"
            ? {
                get(this: ProviderResource) {
                  getterReads += 1;
                  return this.#value;
                },
              }
            : {}),
          set(this: ProviderResource, value: string) {
            this.#value = value;
            return result;
          },
        });
      }

      value() {
        return this.#value;
      }
    }
    const raw = new ProviderResource();
    const registry = new SurfaceObservationRegistry();
    const readGuard = vi.fn<SurfaceReadGuard>((surface, execute) =>
      applySurfacePosture({
        posture: "raise",
        decision: unknownDecision(surface),
        provider: "openai",
        clientShape: "openai_sdk",
        registry,
        warningLatch: new SurfaceWarnOnceLatch(),
        execute,
      }),
    );
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(raw, "models", OPENAI, readGuard);
    const descriptor = Object.getOwnPropertyDescriptor(guarded, "setting");

    expect(descriptor).toMatchObject({ configurable: true, enumerable: true });
    expect(getterReads).toBe(0);
    expect(descriptor?.set?.call(guarded, "after")).toBe(result);
    expect(raw.value()).toBe("after");
    expect(descriptor?.set?.call({}, "foreign receiver")).toBe(result);
    expect(raw.value()).toBe("foreign receiver");
    expect(readGuard).not.toHaveBeenCalled();
    if (kind === "getter-setter") {
      expect(() => descriptor?.get?.call({})).toThrow(UntrackedSpendSurfaceError);
    } else {
      expect(descriptor?.get).toBeUndefined();
      expect(() => Reflect.get(guarded, "setting")).toThrow(UntrackedSpendSurfaceError);
    }
    expect(getterReads).toBe(0);
    expect(registry.size).toBe(0);
  });

  it("invalidates only a successfully reflected setter's binding even when its raw callable is unchanged", () => {
    const failure = new Error("provider rejected mutation");
    class ProviderResource {
      #version = 1;

      constructor() {
        Object.defineProperty(this, "operation", {
          configurable: true,
          get(this: ProviderResource) {
            return this.method;
          },
          set(this: ProviderResource, value: string) {
            if (value === "reject") throw failure;
            this.#version += 1;
            return value;
          },
        });
      }

      method() {
        return this.#version;
      }
    }
    const raw = new ProviderResource();
    const readGuard = vi.fn<SurfaceReadGuard>((_surface, execute) => execute());
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(raw, "models", OPENAI, readGuard);
    const first = Reflect.get(guarded, "operation") as () => number;
    const sibling = guarded.method;
    const descriptor = Object.getOwnPropertyDescriptor(guarded, "operation");

    expect(first()).toBe(1);
    readGuard.mockClear();
    let caught: unknown;
    try {
      descriptor?.set?.call({}, "reject");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(readGuard).not.toHaveBeenCalled();
    expect(Reflect.get(guarded, "operation")).toBe(first);
    expect(first()).toBe(1);
    readGuard.mockClear();
    expect(descriptor?.set?.call({}, "accept")).toBe("accept");
    expect(readGuard).not.toHaveBeenCalled();
    const second = Reflect.get(guarded, "operation") as () => number;
    expect(second).not.toBe(first);
    expect(second()).toBe(2);
    expect(guarded.method).toBe(sibling);
    expect(descriptor?.get?.call({})).toBe(second);
  });

  it.each([
    "getter-setter",
    "setter-only",
  ] as const)("fails closed for reflected fixed %s accessors while direct writes still forward", (kind) => {
    let getterReads = 0;
    class ProviderResource {
      #value = "before";

      constructor() {
        Object.defineProperty(this, "setting", {
          configurable: false,
          ...(kind === "getter-setter"
            ? {
                get(this: ProviderResource) {
                  getterReads += 1;
                  return this.#value;
                },
              }
            : {}),
          set(this: ProviderResource, value: string) {
            this.#value = value;
          },
        });
      }

      value() {
        return this.#value;
      }
    }
    const raw = new ProviderResource();
    const readGuard = vi.fn<SurfaceReadGuard>(() => {
      throw new Error("mutation must not enter read posture");
    });
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(raw, "models", OPENAI, readGuard);

    expect(() => Object.getOwnPropertyDescriptor(guarded, "setting")).toThrow(SolwynError);
    expect(Reflect.set(guarded, "setting", "after", {})).toBe(true);
    expect(raw.value()).toBe("after");
    expect(getterReads).toBe(0);
    expect(readGuard).not.toHaveBeenCalled();
  });

  it("preserves an inert fixed accessor descriptor exactly without evaluating read posture", () => {
    const raw = Object.defineProperty({}, "setting", {
      configurable: false,
      get: undefined,
      set: undefined,
    });
    const readGuard = vi.fn<SurfaceReadGuard>(() => {
      throw new Error("descriptor acquisition must not enter read posture");
    });
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(raw, "models", OPENAI, readGuard);

    expect(Object.getOwnPropertyDescriptor(guarded, "setting")).toEqual(
      Object.getOwnPropertyDescriptor(raw, "setting"),
    );
    expect(Reflect.set(guarded, "setting", "after")).toBe(false);
    expect(readGuard).not.toHaveBeenCalled();
  });

  it.each([
    "data",
    "accessor",
  ] as const)("fails closed when a reflected fixed %s capability cannot be safely represented", (kind) => {
    const resource = { paid: () => "paid" };
    const target = Object.defineProperty({}, "resource", {
      configurable: false,
      ...(kind === "data" ? { value: resource, writable: false } : { get: () => resource }),
    });
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(
      target,
      "models",
      OPENAI,
      (_surface, execute) => new Proxy(execute() as object, {}),
    );

    expect(() => Object.getOwnPropertyDescriptor(guarded, "resource")).toThrow(SolwynError);
  });

  it("runs raise posture before consulting an effectful own-property descriptor trap", () => {
    const cache = new SurfaceNamespaceGuardCache();
    let descriptorReads = 0;
    let valueReads = 0;
    const raw = { paid: "paid" };
    const target = new Proxy(raw, {
      get(current, property, receiver) {
        valueReads += 1;
        return Reflect.get(current, property, receiver);
      },
      getOwnPropertyDescriptor(current, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });
    const guarded = cache.getOrCreate(target, "models", OPENAI, (surface, execute) =>
      applySurfacePosture({
        posture: "raise",
        decision: unknownDecision(surface),
        provider: "openai",
        clientShape: "openai_sdk",
        registry: new SurfaceObservationRegistry(),
        warningLatch: new SurfaceWarnOnceLatch(),
        execute,
      }),
    );

    expect(() => guarded.paid).toThrow(UntrackedSpendSurfaceError);
    expect(descriptorReads).toBe(0);
    expect(valueReads).toBe(0);
  });

  it("fails closed on malformed child names even with a permissive read callback", () => {
    const cache = new SurfaceNamespaceGuardCache();
    let getterReads = 0;
    const target = Object.defineProperty({}, "bad-name", {
      get() {
        getterReads += 1;
        return 1;
      },
    }) as Record<string, unknown>;
    const guarded = cache.getOrCreate(target, "models", OPENAI, (_surface, execute) => execute());

    expect(() => guarded["bad-name"]).toThrow("invalid public surface path");
    expect(getterReads).toBe(0);
  });

  it("fails closed on a symbol-keyed operation before evaluating it", () => {
    const cache = new SurfaceNamespaceGuardCache();
    let iteratorReads = 0;
    const target = Object.defineProperty({}, Symbol.asyncIterator, {
      get() {
        iteratorReads += 1;
        return async function* iterator() {
          yield "paid";
        };
      },
    }) as Record<PropertyKey, unknown>;
    const readGuard = vi.fn<SurfaceReadGuard>((surface, execute) =>
      applySurfacePosture({
        posture: "raise",
        decision: unknownDecision(surface),
        provider: "openai",
        clientShape: "openai_sdk",
        registry: new SurfaceObservationRegistry(),
        warningLatch: new SurfaceWarnOnceLatch(),
        execute,
      }),
    );
    const guarded = cache.getOrCreate(target, "models", OPENAI, readGuard);

    expect(() => guarded[Symbol.asyncIterator]).toThrow(
      "symbol-keyed provider surfaces are not supported",
    );
    expect(iteratorReads).toBe(0);
    expect(readGuard).not.toHaveBeenCalled();
  });

  it("fails closed on Symbol.iterator before descriptor or property lookup", () => {
    const cache = new SurfaceNamespaceGuardCache();
    let descriptorReads = 0;
    let valueReads = 0;
    const target = new Proxy<Record<PropertyKey, unknown>>(
      {},
      {
        get(current, property, receiver) {
          valueReads += 1;
          return Reflect.get(current, property, receiver);
        },
        getOwnPropertyDescriptor(current, property) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(current, property);
        },
      },
    );
    const readGuard = vi.fn<SurfaceReadGuard>((_surface, execute) => execute());
    const guarded = cache.getOrCreate(target, "models", OPENAI, readGuard);

    expect(() => guarded[Symbol.iterator]).toThrow(
      "symbol-keyed provider surfaces are not supported",
    );
    expect(descriptorReads).toBe(0);
    expect(valueReads).toBe(0);
    expect(readGuard).not.toHaveBeenCalled();
  });

  it("binds guarded callables to the raw target with stable identity", () => {
    class ProviderResource {
      readonly #result = "private result";

      operation(): string {
        return this.#result;
      }
    }

    const cache = new SurfaceNamespaceGuardCache();
    const raw = new ProviderResource();
    const inspected: unknown[] = [];
    const guarded = cache.getOrCreate(raw, "models", OPENAI, (_surface, execute) => {
      const value = execute();
      inspected.push(value);
      return value;
    });
    const operation = guarded.operation;

    expect(operation).toBe(guarded.operation);
    expect(operation()).toBe("private result");
    expect(guarded.operation()).toBe("private result");
    expect(inspected).toEqual([raw.operation, raw.operation, raw.operation]);
  });

  it("keeps permitted classes raw through direct and reflected resource reads", () => {
    class Capability {}
    const raw = { Capability };
    const inspected: unknown[] = [];
    const guarded = new SurfaceNamespaceGuardCache().getOrCreate(
      raw,
      "models",
      OPENAI,
      (_surface, execute) => {
        const value = execute();
        inspected.push(value);
        return value;
      },
    );
    expect(guarded.Capability).toBe(Capability);
    expect(Object.getOwnPropertyDescriptor(guarded, "Capability")?.value).toBe(Capability);
    expect(inspected).toEqual([Capability, Capability]);
  });

  it("rebinds when a callable getter returns a different raw function", () => {
    const cache = new SurfaceNamespaceGuardCache();
    let version = 0;
    const target = Object.defineProperty({}, "operation", {
      configurable: true,
      get() {
        version += 1;
        const current = version;
        return () => current;
      },
    }) as { readonly operation: () => number };
    const guarded = cache.getOrCreate(target, "models", OPENAI, (_surface, execute) => execute());

    const first = guarded.operation;
    const second = guarded.operation;

    expect(Object.is(second, first)).toBe(false);
    expect(first()).toBe(1);
    expect(second()).toBe(2);
  });

  it("rebinds after the raw target is replaced outside the guard", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const target = { operation: () => "first" };
    const guarded = cache.getOrCreate(target, "models", OPENAI, (_surface, execute) => execute());
    const first = guarded.operation;

    target.operation = () => "second";
    const second = guarded.operation;

    expect(Object.is(second, first)).toBe(false);
    expect(first()).toBe("first");
    expect(second()).toBe("second");
  });

  it("returns an allowed frozen own callable exactly after running posture", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const rawCallable = () => "fixed";
    const target = Object.defineProperty({}, "operation", {
      configurable: false,
      value: rawCallable,
      writable: false,
    }) as { readonly operation: () => string };
    let guardedSurface: string | undefined;
    const guarded = cache.getOrCreate(target, "models", OPENAI, (surface, execute) => {
      guardedSurface = surface;
      return execute();
    });

    expect(guarded.operation).toBe(rawCallable);
    expect(Object.getOwnPropertyDescriptor(guarded, "operation")).toEqual(
      Object.getOwnPropertyDescriptor(target, "operation"),
    );
    expect(guardedSurface).toBe("models.operation");
  });

  it("preserves undefined for a fixed setter-only accessor after running posture", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const target = Object.defineProperty({}, "writeOnly", {
      configurable: false,
      set(_value: unknown) {},
    }) as { readonly writeOnly: unknown };
    let guardedSurface: string | undefined;
    const guarded = cache.getOrCreate(target, "models", OPENAI, (surface, execute) => {
      guardedSurface = surface;
      return execute();
    });

    expect(guarded.writeOnly).toBeUndefined();
    expect(guardedSurface).toBe("models.writeOnly");
  });

  it("fails closed when a guard substitutes a wrapper for a fixed resource", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const rawResource = Object.freeze({ operation: () => "paid" });
    const guardedResource = new Proxy(rawResource, {});
    const target = Object.defineProperty({}, "resource", {
      configurable: false,
      value: rawResource,
      writable: false,
    }) as { readonly resource: typeof rawResource };
    const guarded = cache.getOrCreate(target, "models", OPENAI, (_surface, execute) => {
      execute();
      return guardedResource;
    });
    const didNotEscape = Object.freeze({ status: "did not escape" });
    let result: unknown = didNotEscape;
    let caught: unknown;

    try {
      result = guarded.resource;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SolwynError);
    expect((caught as Error).message).toBe(
      "guarded result cannot replace a fixed provider property",
    );
    expect(result).toBe(didNotEscape);
  });

  it("throws the typed symbol error for a fixed Symbol.iterator before substitution", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const target = Object.defineProperty({}, Symbol.iterator, {
      configurable: false,
      value: function* iterator() {
        yield "paid";
      },
      writable: false,
    }) as Record<PropertyKey, unknown>;
    const readGuard = vi.fn<SurfaceReadGuard>((_surface, execute) => execute());
    const guarded = cache.getOrCreate(target, "models", OPENAI, readGuard);

    let caught: unknown;
    try {
      void guarded[Symbol.iterator];
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SolwynError);
    expect((caught as Error).message).toBe("symbol-keyed provider surfaces are not supported");
    expect(readGuard).not.toHaveBeenCalled();
  });

  it("invalidates a property's bound callable after set, define, and delete mutations", () => {
    const cache = new SurfaceNamespaceGuardCache();
    const target: Record<string, unknown> = {
      operation(this: Record<string, unknown>) {
        return this["version"];
      },
      version: "first",
    };
    const guarded = cache.getOrCreate(target, "models", OPENAI, (_surface, execute) => execute());
    const first = guarded["operation"] as () => unknown;
    expect(first()).toBe("first");

    guarded["operation"] = () => "second";
    const second = guarded["operation"] as () => unknown;
    expect(second).not.toBe(first);
    expect(second()).toBe("second");

    Object.defineProperty(guarded, "operation", {
      configurable: true,
      value: () => "third",
      writable: true,
    });
    const third = guarded["operation"] as () => unknown;
    expect(third).not.toBe(second);
    expect(third()).toBe("third");

    expect(delete guarded["operation"]).toBe(true);
    Object.defineProperty(guarded, "operation", {
      configurable: true,
      value: () => "fourth",
      writable: true,
    });
    const fourth = guarded["operation"] as () => unknown;
    expect(fourth).not.toBe(third);
    expect(fourth()).toBe("fourth");
  });
});
