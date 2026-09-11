import { describe, expect, it, vi } from "vitest";
import * as surfaces from "../../src/surfaces";
import { createSurfaceRules, type SurfaceContext } from "../../src/surfaces";
import {
  auditPublicSurface,
  declaredNamespacePaths,
  SurfaceCanaryError,
} from "../helpers/surface-audit";

const OPENAI: SurfaceContext = {
  provider: "openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};

const AUDIT = {
  context: OPENAI,
  clientFamily: "fake-openai",
  installedVersion: "1.2.3",
} as const;

function captureCanaryError(run: () => unknown): SurfaceCanaryError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SurfaceCanaryError);
    return error as SurfaceCanaryError;
  }
  throw new Error("expected surface canary to fail");
}

describe("auditPublicSurface", () => {
  it("resolves each raw path at most once within an audit", () => {
    class Widgets {
      create(): void {}
    }
    const rules = createSurfaceRules([
      {
        ruleId: "surface.widgets.namespace",
        surface: "widgets",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "namespace",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "field", returnShape: "resource" }],
      },
      {
        ruleId: "surface.widgets-create.metered",
        surface: "widgets.create",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "metered",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        usageBasis: "provider",
      },
    ]);
    const resolve = vi.spyOn(surfaces, "resolveSurfaceRule");

    try {
      auditPublicSurface({ widgets: new Widgets() }, { ...AUDIT, baselineRows: [], rules });

      expect(resolve.mock.calls.map(([options]) => options.path)).toEqual([
        "widgets",
        "widgets.create",
      ]);
    } finally {
      resolve.mockRestore();
    }
  });

  it("returns a matching curated observation", () => {
    class Widgets {
      create(): void {}
    }
    const rules = createSurfaceRules([
      {
        ruleId: "surface.widgets.namespace",
        surface: "widgets",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "namespace",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "field", returnShape: "resource" }],
      },
      {
        ruleId: "surface.widgets-create.metered",
        surface: "widgets.create",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "metered",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        usageBasis: "provider",
      },
    ]);

    expect(
      auditPublicSurface({ widgets: new Widgets() }, { ...AUDIT, baselineRows: [], rules }),
    ).toEqual([
      { path: "widgets", descriptorCategory: "field", returnShape: "resource" },
      { path: "widgets.create", descriptorCategory: "method", returnShape: "function" },
    ]);
  });

  it("declares a raw resource rule that parents another applicable raw rule", () => {
    class Widgets {
      create(): void {}
    }
    const rules = createSurfaceRules([
      {
        ruleId: "surface.widgets.unmetered_spend",
        surface: "widgets",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "unmetered_spend",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "field", returnShape: "resource" }],
        acknowledgmentToken: "widgets",
        capabilityScope: "resource",
      },
      {
        ruleId: "surface.widgets-create.metered",
        surface: "widgets.create",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "metered",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        usageBasis: "provider",
      },
    ]);

    expect(
      auditPublicSurface({ widgets: new Widgets() }, { ...AUDIT, baselineRows: [], rules }),
    ).toEqual([
      { path: "widgets", descriptorCategory: "field", returnShape: "resource" },
      { path: "widgets.create", descriptorCategory: "method", returnShape: "function" },
    ]);
  });

  it("fails unknown paths without a rule or baseline", () => {
    const error = captureCanaryError(() =>
      auditPublicSurface({ future: () => undefined }, { ...AUDIT, baselineRows: [] }),
    );

    expect(error).toMatchObject({
      clientFamily: "fake-openai",
      installedVersion: "1.2.3",
      path: "future",
      stage: "unknown_classification",
      causeType: undefined,
    });
  });

  it("fails a baseline row with a new encoded shape", () => {
    const error = captureCanaryError(() =>
      auditPublicSurface(
        { future: () => undefined },
        {
          ...AUDIT,
          baselineRows: [["future", ["field:scalar"]]],
        },
      ),
    );

    expect(error).toMatchObject({ path: "future", stage: "shape_drift" });
  });

  it("fails curated shape drift without falling back to a matching baseline", () => {
    const rules = createSurfaceRules([
      {
        ruleId: "surface.future.metered",
        surface: "future",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "metered",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "field", returnShape: "scalar" }],
        usageBasis: "provider",
      },
    ]);
    const error = captureCanaryError(() =>
      auditPublicSurface(
        { future: () => undefined },
        {
          ...AUDIT,
          baselineRows: [["future", ["method:function"]]],
          rules,
        },
      ),
    );

    expect(error).toMatchObject({ path: "future", stage: "shape_drift" });
  });

  it("wraps equally specific raw rules as rule resolution failures", () => {
    const rules = createSurfaceRules([
      {
        ruleId: "surface.future.metered.provider",
        surface: "future",
        selectors: [{ provider: "openai", dialect: null, clientShape: null }],
        kind: "metered",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        usageBasis: "provider",
      },
      {
        ruleId: "surface.future.metered.dialect",
        surface: "future",
        selectors: [{ provider: null, dialect: "openai", clientShape: null }],
        kind: "metered",
        source: "raw",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        usageBasis: "provider",
      },
    ]);
    const error = captureCanaryError(() =>
      auditPublicSurface({ future: () => undefined }, { ...AUDIT, baselineRows: [], rules }),
    );

    expect(error).toMatchObject({
      path: "future",
      stage: "rule_resolution",
      causeType: "SurfaceRuleError",
    });
  });

  it("fails an unknown command class", () => {
    const error = captureCanaryError(() =>
      auditPublicSurface({}, { ...AUDIT, baselineRows: [], commandClasses: ["FutureCommand"] }),
    );

    expect(error).toMatchObject({ path: "FutureCommand", stage: "unknown_classification" });
  });

  it("never evaluates undeclared getters", () => {
    let evaluations = 0;
    const root = Object.defineProperty({}, "lazy", {
      enumerable: true,
      get(): object {
        evaluations += 1;
        return {};
      },
    });

    expect(
      auditPublicSurface(root, {
        ...AUDIT,
        baselineRows: [["lazy", ["getter:unevaluated_accessor"]]],
      }),
    ).toEqual([
      { path: "lazy", descriptorCategory: "getter", returnShape: "unevaluated_accessor" },
    ]);
    expect(evaluations).toBe(0);
  });

  it("exposes exact canary error fields and message", () => {
    const error = captureCanaryError(() =>
      auditPublicSurface({ future: () => undefined }, { ...AUDIT, baselineRows: [] }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.clientFamily).toBe("fake-openai");
    expect(error.installedVersion).toBe("1.2.3");
    expect(error.path).toBe("future");
    expect(error.stage).toBe("unknown_classification");
    expect(error.causeType).toBeUndefined();
    expect(error.message).toBe(
      "Surface canary failed for fake-openai 1.2.3 at 'future' during unknown_classification",
    );
  });

  it("returns an uncurated observation with a matching baseline", () => {
    expect(
      auditPublicSurface(
        { future: () => undefined },
        {
          ...AUDIT,
          baselineRows: [["future", ["method:function"]]],
        },
      ),
    ).toEqual([{ path: "future", descriptorCategory: "method", returnShape: "function" }]);
  });

  it("does not let a wrapper-only rule satisfy a raw observation", () => {
    const rules = createSurfaceRules([
      {
        ruleId: "surface.future.metered.wrapper",
        surface: "future",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "metered",
        source: "wrapper",
        expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
        usageBasis: "provider",
      },
    ]);
    const error = captureCanaryError(() =>
      auditPublicSurface({ future: () => undefined }, { ...AUDIT, baselineRows: [], rules }),
    );

    expect(error).toMatchObject({ path: "future", stage: "unknown_classification" });
  });

  it("leaves an applicable wrapper-only resource namespace getter unevaluated", () => {
    class Widgets {}
    let evaluations = 0;
    const root = Object.defineProperty({}, "widgets", {
      enumerable: true,
      get(): Widgets {
        evaluations += 1;
        return new Widgets();
      },
    });
    const rules = createSurfaceRules([
      {
        ruleId: "surface.widgets.namespace.wrapper",
        surface: "widgets",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        kind: "namespace",
        source: "wrapper",
        expectedShapes: [{ descriptorCategory: "getter", returnShape: "resource" }],
      },
    ]);

    expect(
      auditPublicSurface(root, {
        ...AUDIT,
        baselineRows: [["widgets", ["getter:unevaluated_accessor"]]],
        rules,
      }),
    ).toEqual([
      { path: "widgets", descriptorCategory: "getter", returnShape: "unevaluated_accessor" },
    ]);
    expect(evaluations).toBe(0);
  });
});

describe("declaredNamespacePaths", () => {
  it("returns sorted and unique raw resource namespaces while excluding wrapper-only paths", () => {
    expect(declaredNamespacePaths(OPENAI)).toEqual([
      "audio",
      "audio.speech",
      "audio.transcriptions",
      "chat",
      "chat.completions",
      "embeddings",
      "images",
      "responses",
      "videos",
    ]);
    expect(declaredNamespacePaths(OPENAI)).not.toContain("close");
    expect(declaredNamespacePaths(OPENAI)).not.toContain("audio.translations");
  });
});
