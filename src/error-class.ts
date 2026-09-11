import { FAILOVER_ERROR_CLASS_MAX_LENGTH, FAILOVER_ERROR_CLASS_PATTERN } from "./types";

type ErrorConstructorWithIsError = ErrorConstructor & {
  readonly isError?: (value: unknown) => boolean;
};

/**
 * Project a genuine Error to the same class label Python obtains from
 * `type(exc).__name__`, without reading caller-owned instance properties.
 */
export function safeErrorClassName(error: unknown): string | null {
  try {
    const isErrorDescriptor = Object.getOwnPropertyDescriptor(Error, "isError");
    const isError =
      isErrorDescriptor !== undefined &&
      "value" in isErrorDescriptor &&
      typeof isErrorDescriptor.value === "function"
        ? (isErrorDescriptor.value as ErrorConstructorWithIsError["isError"])
        : undefined;
    const genuine =
      isError === undefined
        ? error instanceof Error
        : Reflect.apply(isError, Error, [error]) === true;
    if (!genuine || error === null || (typeof error !== "object" && typeof error !== "function")) {
      return null;
    }

    // An instance-owned constructor is caller-controlled and does not represent its type.
    // Reject either descriptor shape without reading a data value or invoking an accessor.
    if (Object.getOwnPropertyDescriptor(error, "constructor") !== undefined) {
      return null;
    }

    const prototype = Object.getPrototypeOf(error);
    if (prototype === null) {
      return null;
    }
    const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (
      constructorDescriptor === undefined ||
      !("value" in constructorDescriptor) ||
      typeof constructorDescriptor.value !== "function"
    ) {
      return null;
    }
    const nameDescriptor = Object.getOwnPropertyDescriptor(constructorDescriptor.value, "name");
    if (
      nameDescriptor === undefined ||
      !("value" in nameDescriptor) ||
      typeof nameDescriptor.value !== "string"
    ) {
      return null;
    }

    const name = nameDescriptor.value;
    if (
      name.length === 0 ||
      name.length > FAILOVER_ERROR_CLASS_MAX_LENGTH ||
      !FAILOVER_ERROR_CLASS_PATTERN.test(name)
    ) {
      return null;
    }
    return name;
  } catch {
    // Revoked proxies and caller-controlled reflection traps are unclassifiable.
    return null;
  }
}
