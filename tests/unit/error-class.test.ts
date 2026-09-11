import { describe, expect, it } from "vitest";
import { safeErrorClassName } from "../../src/error-class";

describe("safeErrorClassName", () => {
  it("returns the immediate prototype constructor name for genuine errors", () => {
    class ProviderBoom extends Error {}

    expect(safeErrorClassName(new Error("ordinary"))).toBe("Error");
    expect(safeErrorClassName(new ProviderBoom("provider failed"))).toBe("ProviderBoom");
  });

  it("rejects a constructor-shaped non-Error without reading its getter", () => {
    let reads = 0;
    const forged = Object.defineProperty({}, "constructor", {
      get(): never {
        reads += 1;
        throw new Error("caller accessor was read");
      },
    });

    expect(safeErrorClassName({ constructor: { name: "SecretToken" } })).toBeNull();
    expect(safeErrorClassName(forged)).toBeNull();
    expect(reads).toBe(0);
  });

  it("rejects forged own constructor data and accessors on genuine errors without reading them", () => {
    const withData = Object.defineProperty(new Error("failed"), "constructor", {
      value: { name: "SecretToken" },
    });
    let reads = 0;
    const withAccessor = Object.defineProperty(new Error("failed"), "constructor", {
      get(): never {
        reads += 1;
        throw new Error("caller accessor was read");
      },
    });

    expect(safeErrorClassName(withData)).toBeNull();
    expect(safeErrorClassName(withAccessor)).toBeNull();
    expect(reads).toBe(0);
  });

  it("ignores an instance-owned name accessor", () => {
    let reads = 0;
    const error = Object.defineProperty(new Error("failed"), "name", {
      get(): never {
        reads += 1;
        throw new Error("caller accessor was read");
      },
    });

    expect(safeErrorClassName(error)).toBe("Error");
    expect(reads).toBe(0);
  });

  it("rejects prototype constructor and function-name accessors without reading them", () => {
    let constructorReads = 0;
    const accessorPrototype = Object.create(Error.prototype) as object;
    Object.defineProperty(accessorPrototype, "constructor", {
      get(): never {
        constructorReads += 1;
        throw new Error("prototype accessor was read");
      },
    });
    const prototypeAccessorError = new Error("failed");
    Object.setPrototypeOf(prototypeAccessorError, accessorPrototype);

    let nameReads = 0;
    class NameAccessorBoom extends Error {}
    Object.defineProperty(NameAccessorBoom, "name", {
      configurable: true,
      get(): never {
        nameReads += 1;
        throw new Error("function accessor was read");
      },
    });

    expect(safeErrorClassName(prototypeAccessorError)).toBeNull();
    expect(safeErrorClassName(new NameAccessorBoom("failed"))).toBeNull();
    expect(constructorReads).toBe(0);
    expect(nameReads).toBe(0);
  });

  it("returns null for descriptor traps and revoked proxies", () => {
    const descriptorTrap = new Proxy(Error.prototype, {
      getOwnPropertyDescriptor(): never {
        throw new Error("descriptor trap");
      },
    });
    const trapped = new Error("failed");
    Object.setPrototypeOf(trapped, descriptorTrap);

    const { proxy, revoke } = Proxy.revocable(new Error("failed"), {});
    revoke();

    expect(safeErrorClassName(trapped)).toBeNull();
    expect(safeErrorClassName(proxy)).toBeNull();
  });

  it("enforces the wire identifier and length guard", () => {
    class InvalidBoom extends Error {}
    class LongBoom extends Error {}
    Object.defineProperty(InvalidBoom, "name", { value: "Secret Token" });
    Object.defineProperty(LongBoom, "name", { value: `E${"x".repeat(64)}` });

    expect(safeErrorClassName(new InvalidBoom("failed"))).toBeNull();
    expect(safeErrorClassName(new LongBoom("failed"))).toBeNull();
  });
});
