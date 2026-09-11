import { describe, expect, it, vi } from "vitest";
import {
  observePublicSurface,
  SurfaceInspectionError,
  type SurfaceObservation,
} from "../../src/surface-graph";
import type { ExpectedSurfaceShape } from "../../src/surfaces";

function shape(observation: SurfaceObservation): ExpectedSurfaceShape {
  return {
    descriptorCategory: observation.descriptorCategory,
    returnShape: observation.returnShape,
  };
}

function captureInspectionError(run: () => unknown): SurfaceInspectionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SurfaceInspectionError);
    return error as SurfaceInspectionError;
  }
  throw new Error("expected surface inspection to fail");
}

describe("observePublicSurface", () => {
  it("returns deterministic sorted observations across identical runs", () => {
    const root = {
      zeta: 1,
      alpha(): void {},
    };

    const first = observePublicSurface(root);
    const second = observePublicSurface(root);

    expect(first).toEqual([
      { path: "alpha", descriptorCategory: "method", returnShape: "function" },
      { path: "zeta", descriptorCategory: "field", returnShape: "scalar" },
    ]);
    expect(second).toEqual(first);
  });

  it("classifies static descriptors across the prototype chain in stable path order", () => {
    const operation = vi.fn();
    const ignoredSymbol = Symbol("ignored");
    let lazyEvaluations = 0;
    let namespaceEvaluations = 0;

    class ModelsResource {
      generateContent(): void {
        operation();
      }
    }

    class Client {
      readonly alpha = 1;
      readonly mapping = { enabled: true };
      readonly sequence = [1, 2];
      readonly resource = new ModelsResource();
      readonly operation = operation;
      readonly ConverseCommand = class ConverseCommand {};
      readonly HelperClass = class HelperClass {};
      readonly _private = "ignored";
      readonly [ignoredSymbol] = "ignored";

      get lazy(): object {
        lazyEvaluations += 1;
        return {};
      }

      get models(): ModelsResource {
        namespaceEvaluations += 1;
        return new ModelsResource();
      }

      set writeOnly(_value: unknown) {}

      prototypeMethod(): void {}
    }

    const observations = observePublicSurface(new Client(), { namespaces: ["models"] });

    expect(observations.map(({ path }) => path)).toEqual([
      "ConverseCommand",
      "HelperClass",
      "alpha",
      "lazy",
      "mapping",
      "models",
      "models.generateContent",
      "operation",
      "prototypeMethod",
      "resource",
      "sequence",
      "writeOnly",
    ]);
    expect(Object.fromEntries(observations.map((item) => [item.path, shape(item)]))).toEqual({
      ConverseCommand: {
        descriptorCategory: "command_class",
        returnShape: "command_class",
      },
      HelperClass: { descriptorCategory: "field", returnShape: "class" },
      alpha: { descriptorCategory: "field", returnShape: "scalar" },
      lazy: { descriptorCategory: "getter", returnShape: "unevaluated_accessor" },
      mapping: { descriptorCategory: "field", returnShape: "mapping" },
      models: { descriptorCategory: "getter", returnShape: "resource" },
      "models.generateContent": {
        descriptorCategory: "method",
        returnShape: "function",
      },
      operation: { descriptorCategory: "method", returnShape: "function" },
      prototypeMethod: { descriptorCategory: "method", returnShape: "function" },
      resource: { descriptorCategory: "field", returnShape: "resource" },
      sequence: { descriptorCategory: "field", returnShape: "sequence" },
      writeOnly: {
        descriptorCategory: "setter_only",
        returnShape: "unevaluated_accessor",
      },
    });
    expect(namespaceEvaluations).toBe(1);
    expect(lazyEvaluations).toBe(0);
    expect(operation).not.toHaveBeenCalled();
    expect(Object.isFrozen(observations)).toBe(true);
    expect(observations.every(Object.isFrozen)).toBe(true);
  });

  it("de-duplicates overridden names in favor of the nearest descriptor", () => {
    class Parent {
      value(): void {}
    }
    class Child extends Parent {
      override readonly value = 3 as never;
    }

    expect(observePublicSurface(new Child())).toEqual([
      { path: "value", descriptorCategory: "field", returnShape: "scalar" },
    ]);
  });

  it("stops prototype inspection before Object.prototype and Function.prototype", () => {
    Object.defineProperty(Object.prototype, "fromObjectPrototype", {
      configurable: true,
      value: "PRIVATE_DESCRIPTOR_CONTENT",
    });
    Object.defineProperty(Function.prototype, "fromFunctionPrototype", {
      configurable: true,
      value: "PRIVATE_DESCRIPTOR_CONTENT",
    });
    try {
      expect(observePublicSurface({})).not.toContainEqual({
        path: "fromObjectPrototype",
        descriptorCategory: "field",
        returnShape: "scalar",
      });
      expect(observePublicSurface(function operation() {})).not.toContainEqual({
        path: "fromFunctionPrototype",
        descriptorCategory: "field",
        returnShape: "scalar",
      });
    } finally {
      delete (Object.prototype as { fromObjectPrototype?: unknown }).fromObjectPrototype;
      delete (Function.prototype as { fromFunctionPrototype?: unknown }).fromFunctionPrototype;
    }
  });

  it("skips a missing declared namespace unless all namespaces are required", () => {
    expect(
      observePublicSurface(
        { present: 1 },
        { namespaces: ["missing"], requireAllNamespaces: false },
      ),
    ).toEqual([{ path: "present", descriptorCategory: "field", returnShape: "scalar" }]);

    const error = captureInspectionError(() =>
      observePublicSurface({ present: 1 }, { namespaces: ["missing"], requireAllNamespaces: true }),
    );
    expect(error).toMatchObject({
      path: "missing",
      stage: "missing_namespace",
      causeType: "MissingNamespace",
    });
  });

  it("fails closed when a declared namespace is not traversable", () => {
    const error = captureInspectionError(() =>
      observePublicSurface({ models: 42 }, { namespaces: ["models"] }),
    );
    expect(error).toMatchObject({
      path: "models",
      stage: "invalid_namespace_shape",
      causeType: "number",
    });
  });

  it("reports depth exhaustion and cycles without invoking operations", () => {
    const operation = vi.fn();
    const deep = { a: { b: { create: operation } } };
    expect(
      captureInspectionError(() =>
        observePublicSurface(deep, { namespaces: ["a", "a.b"], maxDepth: 1 }),
      ),
    ).toMatchObject({ path: "a", stage: "depth_exhaustion", causeType: "DepthLimit" });

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(
      captureInspectionError(() => observePublicSurface(cyclic, { namespaces: ["self"] })),
    ).toMatchObject({ path: "self", stage: "cycle", causeType: "Cycle" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("reports a declared child getter returning an ancestor as a cycle", () => {
    const root = Object.defineProperty({}, "child", {
      enumerable: true,
      get(): object {
        return root;
      },
    });

    expect(
      captureInspectionError(() => observePublicSurface(root, { namespaces: ["child"] })),
    ).toMatchObject({ path: "child", stage: "cycle", causeType: "Cycle" });
  });

  it("bounds hostile prototype traversal with structural inspection failures", () => {
    let selfPrototype: object;
    let rootPrototypeCalls = 0;
    selfPrototype = new Proxy(
      {},
      {
        getPrototypeOf: (): object => {
          rootPrototypeCalls += 1;
          if (rootPrototypeCalls > 32) throw new Error("prototype fuse");
          return selfPrototype;
        },
      },
    );
    expect(captureInspectionError(() => observePublicSurface(selfPrototype))).toMatchObject({
      path: "",
      stage: "public_enumeration",
      causeType: "PrototypeCycle",
    });

    let callableSelfPrototype: () => void;
    let callablePrototypeCalls = 0;
    callableSelfPrototype = new Proxy(function operation() {}, {
      getPrototypeOf: (): object => {
        callablePrototypeCalls += 1;
        if (callablePrototypeCalls > 32) throw new Error("prototype fuse");
        return callableSelfPrototype;
      },
    });
    expect(
      captureInspectionError(() => observePublicSurface({ callableSelfPrototype })),
    ).toMatchObject({
      path: "callableSelfPrototype",
      stage: "static_inspection",
      causeType: "PrototypeCycle",
    });

    let objectSelfPrototype: object;
    let objectPrototypeCalls = 0;
    objectSelfPrototype = new Proxy(
      {},
      {
        getPrototypeOf: (): object => {
          objectPrototypeCalls += 1;
          if (objectPrototypeCalls > 32) throw new Error("prototype fuse");
          return objectSelfPrototype;
        },
      },
    );
    expect(
      captureInspectionError(() => observePublicSurface({ objectSelfPrototype })),
    ).toMatchObject({
      path: "objectSelfPrototype",
      stage: "static_inspection",
      causeType: "PrototypeCycle",
    });
  });

  it("degrades a self-prototype getter cause and stops fresh proxy chains at 24 links", () => {
    let freshPrototypeCalls = 0;
    let thrownCause: object;
    let thrownCausePrototypeCalls = 0;
    thrownCause = new Proxy(
      {},
      {
        getPrototypeOf: (): object => {
          thrownCausePrototypeCalls += 1;
          if (thrownCausePrototypeCalls > 32) throw new Error("prototype fuse");
          return thrownCause;
        },
      },
    );
    const root = Object.defineProperty({}, "models", {
      get(): never {
        throw thrownCause;
      },
    });
    expect(
      captureInspectionError(() => observePublicSurface(root, { namespaces: ["models"] })),
    ).toMatchObject({ path: "models", stage: "namespace_evaluation", causeType: "object" });

    const fresh = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          freshPrototypeCalls += 1;
          if (freshPrototypeCalls > 32) throw new Error("prototype fuse");
          return new Proxy({}, this);
        },
      },
    );
    expect(captureInspectionError(() => observePublicSurface(fresh))).toMatchObject({
      path: "",
      stage: "public_enumeration",
      causeType: "PrototypeDepthLimit",
    });
    expect(freshPrototypeCalls).toBe(24);
  });

  it("wraps throwing namespace getters with structural cause data only", () => {
    const secret = "unsafe provider body";
    const root = Object.defineProperty({}, "models", {
      enumerable: true,
      get(): never {
        throw new TypeError(secret);
      },
    });

    const error = captureInspectionError(() =>
      observePublicSurface(root, { namespaces: ["models"] }),
    );
    expect(error).toMatchObject({
      path: "models",
      stage: "namespace_evaluation",
      causeType: "TypeError",
    });
    expect(error.message).toContain("models");
    expect(error.message).toContain("namespace_evaluation");
    expect(error.message).not.toContain(secret);
    expect(error.toString()).not.toContain(secret);
  });

  it("never trusts an arbitrary thrown object's name as a cause class label", () => {
    const secret = "PRIVATE_DESCRIPTOR_CONTENT";
    const root = Object.defineProperty({}, "models", {
      enumerable: true,
      get(): never {
        throw { name: secret };
      },
    });

    const error = captureInspectionError(() =>
      observePublicSurface(root, { namespaces: ["models"] }),
    );
    expect(error).toMatchObject({
      path: "models",
      stage: "namespace_evaluation",
      causeType: "object",
    });
    expect(error.message).not.toContain(secret);
    expect(error.toString()).not.toContain(secret);
  });

  it("does not include a declared getter's literal value in structural error data", () => {
    const secret = "PRIVATE_DESCRIPTOR_CONTENT";
    const root = Object.defineProperty({}, "models", {
      enumerable: true,
      get(): string {
        return secret;
      },
    });

    const error = captureInspectionError(() =>
      observePublicSurface(root, { namespaces: ["models"] }),
    );
    expect(error).toMatchObject({
      path: "models",
      stage: "invalid_namespace_shape",
      causeType: "string",
    });
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(Object.values(error)).not.toContain(secret);
  });

  it("ignores an arbitrary thrown object's own constructor name", () => {
    const attackerSelectedName = "PrivateProviderConstructor";
    const attackerConstructor = Object.defineProperty(() => undefined, "name", {
      value: attackerSelectedName,
    });
    const forgedCause = Object.defineProperty({}, "constructor", {
      enumerable: true,
      value: attackerConstructor,
    });
    const root = Object.defineProperty({}, "models", {
      enumerable: true,
      get(): never {
        throw forgedCause;
      },
    });

    const error = captureInspectionError(() =>
      observePublicSurface(root, { namespaces: ["models"] }),
    );
    expect(error).toMatchObject({
      path: "models",
      stage: "namespace_evaluation",
      causeType: "object",
    });
    expect(JSON.stringify(error)).not.toContain(attackerSelectedName);
    expect(error.toString()).not.toContain(attackerSelectedName);
  });

  it("reports proxy enumeration and descriptor failures as typed, data-free stages", () => {
    const enumerationError = captureInspectionError(() =>
      observePublicSurface(
        new Proxy(
          {},
          {
            ownKeys(): never {
              throw new RangeError("unsafe enumeration detail");
            },
          },
        ),
      ),
    );
    expect(enumerationError).toMatchObject({
      path: "",
      stage: "public_enumeration",
      causeType: "RangeError",
    });
    expect(enumerationError.message).toContain("<root>");
    expect(enumerationError.message).toContain("public_enumeration");

    const inspectionError = captureInspectionError(() =>
      observePublicSurface(
        new Proxy(
          {},
          {
            ownKeys: () => ["safe"],
            getOwnPropertyDescriptor(): never {
              throw new SyntaxError("unsafe descriptor detail");
            },
          },
        ),
      ),
    );
    expect(inspectionError).toMatchObject({
      path: "safe",
      stage: "static_inspection",
      causeType: "SyntaxError",
    });
    expect(inspectionError.message).not.toContain("unsafe descriptor detail");
    expect(inspectionError.message).toContain("safe");
    expect(inspectionError.message).toContain("static_inspection");
  });

  it("normalizes hostile and revoked descriptor values into typed inspection failures", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new URIError("unsafe shape detail");
        },
      },
    );
    const hostileError = captureInspectionError(() => observePublicSurface({ hostile }));
    expect(hostileError).toMatchObject({
      path: "hostile",
      stage: "static_inspection",
      causeType: "URIError",
    });
    expect(hostileError.message).toContain("hostile");
    expect(hostileError.message).toContain("static_inspection");
    expect(hostileError.message).not.toContain("unsafe shape detail");

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const revokedError = captureInspectionError(() =>
      observePublicSurface({ revoked: revocable.proxy }),
    );
    expect(revokedError).toMatchObject({
      path: "revoked",
      stage: "static_inspection",
      causeType: "TypeError",
    });
  });

  it("rejects malformed public names without echoing the unsafe property", () => {
    const unsafeName = "bad-name";
    const root = Object.defineProperty({}, unsafeName, { value: 1, enumerable: true });
    const error = captureInspectionError(() => observePublicSurface(root));

    expect(error).toMatchObject({
      path: "",
      stage: "invalid_public_name",
      causeType: "InvalidPublicName",
    });
    expect(error.message).not.toContain(unsafeName);
    expect(error.path).not.toContain(unsafeName);
  });
});
