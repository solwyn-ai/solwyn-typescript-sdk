import { describe, expect, it, vi } from "vitest";
import { SolwynError } from "../../src/errors";
import { noopLogger } from "../../src/logging";
import {
  captureTags,
  copyTags,
  TAG_KEY_MAX_LENGTH,
  TAG_VALUE_MAX_LENGTH,
  TAGS_MAX_KEYS,
} from "../../src/tags";

const REFLECTION_SECRET = "secret-tag=value\nforged";

const REFLECTION_FAILURES: Array<[string, () => Record<string, string>]> = [
  [
    "array classification on a revoked proxy",
    () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy as Record<string, string>;
    },
  ],
  [
    "prototype lookup",
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error(REFLECTION_SECRET);
          },
        },
      ),
  ],
  [
    "own-symbol enumeration",
    () =>
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error(REFLECTION_SECRET);
          },
        },
      ),
  ],
  [
    "own-name enumeration",
    () => {
      let enumerationCount = 0;
      return new Proxy(
        { key: "value" },
        {
          ownKeys(target) {
            enumerationCount += 1;
            if (enumerationCount === 2) throw new Error(REFLECTION_SECRET);
            return Reflect.ownKeys(target);
          },
        },
      );
    },
  ],
  [
    "own-property descriptor lookup",
    () =>
      new Proxy(
        { key: "value" },
        {
          getOwnPropertyDescriptor() {
            throw new Error(REFLECTION_SECRET);
          },
        },
      ),
  ],
];

describe("copyTags", () => {
  it("pins the public bounds and accepts their inclusive Unicode code-point limits", () => {
    expect(TAGS_MAX_KEYS).toBe(10);
    expect(TAG_KEY_MAX_LENGTH).toBe(64);
    expect(TAG_VALUE_MAX_LENGTH).toBe(256);

    const key = "🦊".repeat(64);
    const value = "🌲".repeat(256);
    expect(copyTags({ [key]: value, empty: "" }, "tags")).toEqual({
      [key]: value,
      empty: "",
    });
    expect(() => copyTags({ ["🦊".repeat(65)]: "v" }, "tags")).toThrow(/max length 64/);
    expect(() => copyTags({ key: "🌲".repeat(257) }, "tags")).toThrow(/max length 256/);
  });

  it("normalizes nullish and empty inputs to undefined", () => {
    expect(copyTags(undefined, "tags")).toBeUndefined();
    expect(copyTags(null, "tags")).toBeUndefined();
    expect(copyTags({}, "tags")).toBeUndefined();
    expect(copyTags(Object.create(null) as Record<string, string>, "tags")).toBeUndefined();
  });

  it.each([
    ["array", []],
    ["date", new Date()],
    ["map", new Map([["key", "value"]])],
    ["class instance", new (class Tags {})()],
    ["string", "key=value"],
    ["number", 1],
  ])("rejects a non-record %s with a typed, labeled error", (_label, value) => {
    let caught: unknown;
    try {
      copyTags(value, "solwyn_tags");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SolwynError);
    expect((caught as Error).message).toContain("solwyn_tags");
  });

  it.each(
    REFLECTION_FAILURES,
  )("normalizes %s failures to a typed, labeled, data-free error", (_label, makeTags) => {
    let caught: unknown;
    try {
      copyTags(makeTags(), "tags");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SolwynError);
    expect((caught as Error).message).toBe(
      "tags requires a plain record of string keys to string values",
    );
    expect((caught as Error).message).not.toContain("secret-tag");
    expect((caught as Error).message).not.toContain("\n");
  });

  it("rejects symbol keys, invalid values, empty keys, NUL, bounds, and count", () => {
    const withSymbol = { key: "value", [Symbol("secret")]: "hidden" };
    const invalid: unknown[] = [
      withSymbol,
      { key: 1 },
      { key: null },
      { "": "value" },
      { ["k".repeat(65)]: "value" },
      { key: "v".repeat(257) },
      { "bad\0key": "value" },
      { key: "bad\0value" },
      Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key-${index}`, "value"])),
    ];

    for (const value of invalid) {
      expect(() => copyTags(value, "solwyn.run(tags)")).toThrow(SolwynError);
      expect(() => copyTags(value, "solwyn.run(tags)")).toThrow(/solwyn\.run\(tags\)/);
    }
  });

  it("preserves strings exactly and snapshots caller-owned input", () => {
    const caller = { " Team ": " Value ", MiXeD: "é" };
    const stored = copyTags(caller, "tags");
    caller[" Team "] = "mutated";
    expect(stored).toEqual({ " Team ": " Value ", MiXeD: "é" });
    expect(stored).not.toBe(caller);
  });

  it("preserves valid non-enumerable own string properties", () => {
    const caller = { visible: "value" };
    Object.defineProperty(caller, "hidden", { value: "preserved" });

    expect(copyTags(caller, "tags")).toEqual({ visible: "value", hidden: "preserved" });
  });

  it.each([
    ["non-string value", { value: 1 }],
    ["accessor", { get: () => "value" }],
  ])("rejects a non-enumerable own %s", (_label, descriptor) => {
    const caller = { visible: "value" };
    Object.defineProperty(caller, "hidden", descriptor);

    expect(() => copyTags(caller, "tags")).toThrow(SolwynError);
  });

  it("accepts null-prototype records and safely copies an own __proto__ key", () => {
    const caller = Object.create(null) as Record<string, string>;
    Reflect.set(caller, "__proto__", "safe");
    caller["constructor"] = "also-safe";

    const stored = copyTags(caller, "tags");
    expect(Reflect.get(stored ?? {}, "__proto__")).toBe("safe");
    expect(stored?.["constructor"]).toBe("also-safe");
    expect(Object.hasOwn(stored ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
  });
});

describe("captureTags", () => {
  it("merges per-call, scope, then defaults with first-writer precedence and stable order", () => {
    const captured = captureTags({
      perCallTags: { shared: "call", call: "1" },
      runTags: { shared: "scope", scope: "2" },
      defaultTags: { shared: "default", default: "3" },
      logger: noopLogger,
    });

    expect(captured).toEqual({ shared: "call", call: "1", scope: "2", default: "3" });
    expect(Object.keys(captured ?? {})).toEqual(["shared", "call", "scope", "default"]);
  });

  it("checks duplicates before capacity and accepts exactly ten unique keys", () => {
    const perCallTags = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`key-${index}`, `call-${index}`]),
    );
    const warn = vi.fn();
    const captured = captureTags({
      perCallTags,
      runTags: { "key-9": "scope-duplicate" },
      logger: { ...noopLogger, warn },
    });

    expect(captured).toEqual(perCallTags);
    expect(warn).not.toHaveBeenCalled();
  });

  it("clamps lower-priority new keys and warns exactly once without exposing tag data", () => {
    const perCallTags = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`call-${index}`, "secret-call"]),
    );
    const runTags = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`scope-${index}`, "secret-scope"]),
    );
    const warn = vi.fn();
    const captured = captureTags({
      perCallTags,
      runTags,
      defaultTags: { lowest: "secret-default" },
      logger: { ...noopLogger, warn },
    });

    expect(Object.keys(captured ?? {})).toEqual([
      "call-0",
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
      "scope-0",
      "scope-1",
      "scope-2",
      "scope-3",
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "merged tags exceed 10 keys; lower-priority tags were dropped",
    );
  });

  it("allows an inherited scope above ten keys until capture clamps it", () => {
    const runTags = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`scope-${index}`, `value-${index}`]),
    );
    const warn = vi.fn();
    const captured = captureTags({ runTags, logger: { ...noopLogger, warn } });

    expect(Object.keys(captured ?? {})).toHaveLength(10);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("suppresses a throwing logger and returns a defensive snapshot", () => {
    const perCallTags = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`key-${index}`, `value-${index}`]),
    );
    const throwingLogger = {
      ...noopLogger,
      warn(): void {
        throw new Error("logging failed");
      },
    };
    const captured = captureTags({
      perCallTags,
      runTags: { overflow: "value" },
      logger: throwingLogger,
    });

    perCallTags["key-0"] = "mutated";
    expect(captured?.["key-0"]).toBe("value-0");
  });

  it("returns undefined for an empty merge", () => {
    expect(captureTags({ logger: noopLogger })).toBeUndefined();
    expect(
      captureTags({ perCallTags: {}, runTags: undefined, defaultTags: null, logger: noopLogger }),
    ).toBeUndefined();
  });
});
